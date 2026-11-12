/** Ciphertext-only OutLayer testnet preparation. Importing never reads secrets.
 * ECIES source: out-layer/outlayer-cli v0.2.3, src/crypto.rs.
 * The HTTPS pubkey channel is trusted; it supplies no independently bound quote.
 */
import {
  createCipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROFILE = "proofcredit-rpc-v1";
const PUBKEY_URL = "https://testnet-api.outlayer.ai/secrets/pubkey";
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const HASH = /^[a-f0-9]{64}$/;
const ACCOUNT = /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export function parseAlchemyEndpoint(value) {
  // Match before URL parsing: WHATWG normalization must not admit traversal,
  // escapes, credentials, whitespace, alternate networks, or alternate hosts.
  const match =
    typeof value === "string" &&
    /^https:\/\/eth-sepolia\.g\.alchemy\.com(?::443)?\/v2\/([A-Za-z0-9_-]{8,128})$/.exec(
      value,
    );
  if (!match || match[0] !== value)
    throw new Error("Invalid Alchemy Sepolia endpoint (redacted)");
  return {
    url: `https://eth-sepolia.g.alchemy.com/v2/${match[1]}`,
    key: match[1],
  };
}

function validBinding(hash, owner) {
  if (
    typeof hash !== "string" ||
    !HASH.test(hash) ||
    typeof owner !== "string" ||
    !ACCOUNT.test(owner)
  )
    throw new Error("Invalid secret binding");
}

function recipientKey(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32)
    throw new Error("Invalid recipient key");
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, bytes]),
    format: "der",
    type: "spki",
  });
}

function checkedShared(privateKey, publicKey) {
  // OpenSSL rejects known low-order X25519 inputs; also explicitly reject an
  // all-zero shared result in case crypto backend behavior changes.
  const shared = diffieHellman({ privateKey, publicKey });
  if (shared.length !== 32 || shared.every((byte) => byte === 0))
    throw new Error("Invalid recipient key");
  return shared;
}

export function validatePubkeyResponse(response, hash, owner) {
  try {
    validBinding(hash, owner);
    if (
      !response ||
      typeof response !== "object" ||
      response.owner !== owner ||
      response.accessor?.type !== "WasmHash" ||
      response.accessor?.hash !== hash ||
      typeof response.pubkey !== "string" ||
      !/^[a-fA-F0-9]{64}$/.test(response.pubkey)
    )
      throw new Error();
    const key = Buffer.from(response.pubkey, "hex");
    const probe = generateKeyPairSync("x25519");
    const shared = checkedShared(probe.privateKey, recipientKey(key));
    shared.fill(0);
    return key;
  } catch {
    throw new Error("Invalid OutLayer encryption public key response");
  }
}

export function encryptSecretJson(plaintext, pubkey) {
  let shared, symmetric;
  try {
    if (
      !(plaintext instanceof Uint8Array) ||
      plaintext.length === 0 ||
      plaintext.length > 16_384
    )
      throw new Error();
    const ephemeral = generateKeyPairSync("x25519");
    shared = checkedShared(ephemeral.privateKey, recipientKey(pubkey));
    // Rust Hkdf::new(None, ...) is RFC5869's empty/zero salt. No AAD.
    symmetric = Buffer.from(
      hkdfSync(
        "sha256",
        shared,
        Buffer.alloc(0),
        Buffer.from("outlayer-keystore-v1"),
        32,
      ),
    );
    const nonce = randomBytes(12);
    const cipher = createCipheriv("chacha20-poly1305", symmetric, nonce, {
      authTagLength: 16,
    });
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    const ephemeralRaw = Buffer.from(
      ephemeral.publicKey.export({ format: "jwk" }).x,
      "base64url",
    );
    return Buffer.concat([
      Buffer.from([1]),
      ephemeralRaw,
      nonce,
      ciphertext,
      cipher.getAuthTag(),
    ]).toString("base64");
  } catch {
    throw new Error("Secret encryption failed (redacted)");
  } finally {
    shared?.fill(0);
    symmetric?.fill(0);
  }
}

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function secretStoreArgs(hash, owner, borrower, lender, ciphertext) {
  validBinding(hash, owner);
  for (const account of [borrower, lender])
    if (typeof account !== "string" || !ACCOUNT.test(account))
      throw new Error("Invalid secret access account");
  if (
    typeof ciphertext !== "string" ||
    ciphertext.length > 24_000 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext)
  )
    throw new Error("Invalid secret ciphertext");
  const wire = Buffer.from(ciphertext, "base64");
  if (
    wire.length <= 61 ||
    wire[0] !== 1 ||
    wire.toString("base64") !== ciphertext
  )
    throw new Error("Invalid secret ciphertext");
  return freeze({
    accessor: { WasmHash: { hash } },
    profile: PROFILE,
    encrypted_secrets_base64: ciphertext,
    access: {
      Logic: {
        operator: "And",
        conditions: [
          { Whitelist: { accounts: [borrower, lender] } },
          { Predecessor: { condition: { Whitelist: { accounts: [owner] } } } },
        ],
      },
    },
    vault_id: null,
  });
}

function directory(path, create = false) {
  try {
    if (!lstatSync(path).isDirectory()) throw new Error();
  } catch (error) {
    if (!create || error?.code !== "ENOENT") throw new Error();
    mkdirSync(path, { mode: 0o700 });
    if (!lstatSync(path).isDirectory()) throw new Error();
  }
}

function outputPath(root, value) {
  if (typeof value !== "string" || !value.startsWith(".local/"))
    throw new Error();
  const parts = value.split("/");
  if (
    parts.length < 2 ||
    parts.some(
      (part) =>
        !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === "..",
    ) ||
    !parts.at(-1).endsWith(".json")
  )
    throw new Error();
  const ignore = readFileSync(join(root, ".gitignore"), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  const rule = Math.max(
    ignore.lastIndexOf(".local/"),
    ignore.lastIndexOf("/.local/"),
  );
  // Conservatively refuse later root negations capable of reopening .local.
  if (
    rule < 0 ||
    ignore
      .slice(rule + 1)
      .some((line) => line.startsWith("!") && /(?:\.local|[?*])/.test(line))
  )
    throw new Error();
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    directory(parent, true);
  }
  const path = join(parent, parts.at(-1));
  try {
    lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return path;
  }
  throw new Error();
}

function localEndpoint(root) {
  directory(join(root, ".local"));
  directory(join(root, ".local/rpc"));
  const fd = openSync(
    join(root, ".local/rpc/sepolia.env"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16_384) throw new Error();
    const lines = readFileSync(fd, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.startsWith("ALCHEMY_SEPOLIA_RPC_URL="));
    if (lines.length !== 1) throw new Error();
    let value = lines[0].slice("ALCHEMY_SEPOLIA_RPC_URL=".length).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    return parseAlchemyEndpoint(value).key;
  } finally {
    closeSync(fd);
  }
}

async function publicKey(hash, owner) {
  const response = await fetch(PUBKEY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(18_000),
    body: JSON.stringify({
      accessor: { type: "WasmHash", hash },
      owner,
      profile: PROFILE,
      secrets_json: '{"ALCHEMY_API_KEY":""}',
    }),
  });
  if (!response.ok || !response.body) throw new Error();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) throw new Error();
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return validatePubkeyResponse(
    JSON.parse(Buffer.concat(chunks).toString("utf8")),
    hash,
    owner,
  );
}

async function main() {
  const options = new Map();
  const args = process.argv.slice(2);
  const allowed = ["--hash", "--owner", "--borrower", "--lender", "--out"];
  if (args.length !== allowed.length * 2) throw new Error();
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || options.has(args[i])) throw new Error();
    options.set(args[i], args[i + 1]);
  }
  const hash = options.get("--hash"),
    owner = options.get("--owner");
  const borrower = options.get("--borrower"),
    lender = options.get("--lender");
  validBinding(hash, owner);
  validBinding(hash, borrower);
  validBinding(hash, lender);
  const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
  const path = outputPath(root, options.get("--out"));
  let plaintext;
  try {
    const key = localEndpoint(root);
    const recipient = await publicKey(hash, owner);
    plaintext = Buffer.from(JSON.stringify({ ALCHEMY_API_KEY: key }));
    const store_args = secretStoreArgs(
      hash,
      owner,
      borrower,
      lender,
      encryptSecretJson(plaintext, recipient),
    );
    const data = { owner, store_args, estimate_args: { ...store_args, owner } };
    // O_EXCL rejects both existing files and final-component symlinks.
    const fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, JSON.stringify(data, null, 2) + "\n");
    } finally {
      closeSync(fd);
    }
  } finally {
    plaintext?.fill(0);
  }
}

// Node24's entry-point flag handles macOS /var -> /private/var aliases without
// performing any CLI work when this module is imported.
if (import.meta.main) {
  main().catch(() => {
    process.stderr.write("Secret preparation failed (redacted)\n");
    process.exitCode = 1;
  });
}
