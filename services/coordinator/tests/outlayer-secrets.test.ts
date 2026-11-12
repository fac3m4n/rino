import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
} from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const deterministic = vi.hoisted(() => ({ enabled: false }));
// Control only crypto randomness for the frozen vector, with no production hook.
vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  return {
    ...real,
    generateKeyPairSync: (...args: unknown[]) => {
      if (!deterministic.enabled)
        return (real.generateKeyPairSync as Function)(...args);
      // RFC7748 Alice private key (public vector, never a deployed credential).
      const privateKey = real.createPrivateKey({
        key: Buffer.from(
          "302e020100300506032b656e0422042077076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
          "hex",
        ),
        format: "der",
        type: "pkcs8",
      });
      return { privateKey, publicKey: real.createPublicKey(privateKey) };
    },
    randomBytes: (size: number) =>
      deterministic.enabled
        ? Buffer.from("000102030405060708090a0b", "hex")
        : real.randomBytes(size),
  };
});
import {
  encryptSecretJson,
  parseAlchemyEndpoint,
  secretStoreArgs,
  validatePubkeyResponse,
} from "../../../tooling/outlayer-secrets.mjs";

const hash = "a".repeat(64),
  owner = "controller.testnet",
  borrower = "borrower.testnet",
  lender = "lender.testnet";
const testKey = "proofcredit-synthetic-key",
  endpoint = `https://eth-sepolia.g.alchemy.com/v2/${testKey}`;
const plaintext = Buffer.from(JSON.stringify({ ALCHEMY_API_KEY: testKey }));
// RFC7748 Bob key pair: independent public interoperability vector.
const recipient = Buffer.from(
  "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f",
  "hex",
);
const recipientPrivate = createPrivateKey({
  key: Buffer.from(
    "302e020100300506032b656e042204205dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb",
    "hex",
  ),
  format: "der",
  type: "pkcs8",
});
const response = {
  accessor: { type: "WasmHash", hash },
  owner,
  pubkey: recipient.toString("hex"),
};

// Independent decoder: JWK key import, and RFC5869 extract/expand via HMAC
// instead of the helper's DER import and hkdfSync. No helper internals reused.
function decrypt(encoded: string) {
  const wire = Buffer.from(encoded, "base64");
  if (wire[0] !== 1 || wire.length < 61) throw new Error("invalid frame");
  const publicKey = createPublicKey({
    key: {
      kty: "OKP",
      crv: "X25519",
      x: wire.subarray(1, 33).toString("base64url"),
    },
    format: "jwk",
  });
  const shared = diffieHellman({ privateKey: recipientPrivate, publicKey });
  const extracted = createHmac("sha256", Buffer.alloc(32))
    .update(shared)
    .digest();
  const key = createHmac("sha256", extracted)
    .update(Buffer.from("outlayer-keystore-v1"))
    .update(Buffer.from([1]))
    .digest();
  const cipher = createDecipheriv(
    "chacha20-poly1305",
    key,
    wire.subarray(33, 45),
    { authTagLength: 16 },
  );
  cipher.setAuthTag(wire.subarray(-16));
  return Buffer.concat([cipher.update(wire.subarray(45, -16)), cipher.final()]);
}
afterEach(() => {
  deterministic.enabled = false;
});

describe("fixed credential boundary", () => {
  it("extracts only the fixed Alchemy Sepolia endpoint and port443", () => {
    expect(parseAlchemyEndpoint(endpoint)).toEqual({
      url: endpoint,
      key: testKey,
    });
    expect(
      parseAlchemyEndpoint(endpoint.replace(".com/", ".com:443/")),
    ).toEqual({ url: endpoint, key: testKey });
  });
  it.each([
    undefined,
    null,
    {},
    "",
    endpoint + "\n",
    " " + endpoint,
    endpoint.replace("https:", "http:"),
    endpoint.replace(".com/", ".com:444/"),
    endpoint.replace(".com/", ".com.evil/"),
    endpoint.replace("https://", "https://user:pass@"),
    endpoint.replace("/v2/", "/mainnet/"),
    endpoint.replace("/v2/", "/v2/../v2/"),
    endpoint.replace("/v2/", "/%76%32/"),
    endpoint.replace("/v2/", "\\v2\\"),
    endpoint + "?secret=" + testKey,
    endpoint + "#" + testKey,
    endpoint + "/",
    "https://eth-sepolia.g.alchemy.com/v2/short",
    "https://eth-sepolia.g.alchemy.com/v2/" + "x".repeat(129),
    "https://eth-sepolia.g.alchemy.com/v2/" + "é".repeat(8),
  ])("rejects hostile endpoint without echoing input (%#)", (value) => {
    expect(() => parseAlchemyEndpoint(value)).toThrow(
      "Invalid Alchemy Sepolia endpoint (redacted)",
    );
  });
});

describe("hash/owner bound ECIES", () => {
  it("requires the exact owner and hash echoes and decodes the public preflight fixture", () => {
    expect(validatePubkeyResponse(response, hash, owner)).toEqual(recipient);
    // Non-secret response captured 2026-11-12; embedded so tests need no cache.
    const publicHash =
      "be818d821f076d5e1dbf3650b03811b7658c85b14fd5c2fa7abce4ac87184c69";
    expect(
      validatePubkeyResponse(
        {
          accessor: { type: "WasmHash", hash: publicHash },
          owner: "proofcredit-c-2593ce.testnet",
          pubkey:
            "32b5ae4112cab8cd1d9b46387f0f028c342ebdbee71c1593e1b7da78cf4bc841",
        },
        publicHash,
        "proofcredit-c-2593ce.testnet",
      ),
    ).toHaveLength(32);
  });
  it.each([
    null,
    { ...response, owner: borrower },
    { ...response, accessor: { type: "WasmHash", hash: "b".repeat(64) } },
    { ...response, accessor: { type: "Project", hash } },
    { ...response, accessor: undefined },
    { ...response, pubkey: "ab" },
    { ...response, pubkey: "g".repeat(64) },
    { ...response, pubkey: recipient.toString("hex") + "\n" },
    { ...response, pubkey: "00".repeat(32) },
    { ...response, pubkey: "01" + "00".repeat(31) },
    { ...response, pubkey: "ec" + "ff".repeat(30) + "7f" },
    { ...response, pubkey: "ed" + "ff".repeat(30) + "7f" },
    { ...response, pubkey: "ee" + "ff".repeat(30) + "7f" },
    {
      ...response,
      pubkey:
        "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
    },
    {
      ...response,
      pubkey:
        "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
    },
  ])(
    "rejects malformed/mismatched metadata and low-order keys (%#)",
    (value) => {
      expect(() => validatePubkeyResponse(value, hash, owner)).toThrow(
        "Invalid OutLayer encryption public key response",
      );
    },
  );
  it("matches the frozen RFC7748-based ECIESv1 vector exactly", () => {
    deterministic.enabled = true;
    expect(encryptSecretJson(plaintext, recipient)).toBe(
      "AYUg8AmJMKdUdIt93LQ+91oNvzoNJjga9OukqY6qm05qAAECAwQFBgcICQoLdrVM+5qfeGndErCCEOVFRXqwpRjq27LmR0M3U4HaQUs9xiNOpqlv7NbEqUBYnAw4nT2C5P2BRzBxGWd04Eup",
    );
  });
  it("independently decrypts fresh frames with empty HKDF salt and trailing tag", () => {
    const first = encryptSecretJson(plaintext, recipient),
      second = encryptSecretJson(plaintext, recipient);
    expect(first).not.toBe(second);
    expect(decrypt(first)).toEqual(plaintext);
    expect(decrypt(second)).toEqual(plaintext);
    expect(Buffer.from(first, "base64")).toHaveLength(61 + plaintext.length);
  });
  it.each([0, 1, 33, 45, 61, 80, 104])(
    "independently rejects tampered wire byte %i",
    (position) => {
      const wire = Buffer.from(
        encryptSecretJson(plaintext, recipient),
        "base64",
      );
      wire[position % wire.length] ^= 1;
      expect(() => decrypt(wire.toString("base64"))).toThrow();
    },
  );
  it("redacts crypto errors for malformed or low-order recipient keys", () => {
    for (const key of [
      Buffer.alloc(0),
      Buffer.alloc(31),
      Buffer.alloc(32),
      Buffer.concat([Buffer.from([1]), Buffer.alloc(31)]),
    ])
      expect(() => encryptSecretJson(plaintext, key)).toThrow(
        "Secret encryption failed (redacted)",
      );
  });
  it("constructs an immutable ciphertext-only borrower/lender-through-owner policy", () => {
    const ciphertext = encryptSecretJson(plaintext, recipient),
      args = secretStoreArgs(hash, owner, borrower, lender, ciphertext);
    expect(args).toEqual({
      accessor: { WasmHash: { hash } },
      profile: "proofcredit-rpc-v1",
      encrypted_secrets_base64: ciphertext,
      access: {
        Logic: {
          operator: "And",
          conditions: [
            { Whitelist: { accounts: [borrower, lender] } },
            {
              Predecessor: { condition: { Whitelist: { accounts: [owner] } } },
            },
          ],
        },
      },
      vault_id: null,
    });
    expect(Object.isFrozen(args)).toBe(true);
    expect(Object.isFrozen(args.access.Logic.conditions)).toBe(true);
    expect(
      Object.isFrozen(args.access.Logic.conditions[0].Whitelist.accounts),
    ).toBe(true);
    expect(JSON.stringify(args)).not.toContain(testKey);
    expect(JSON.stringify(args)).not.toContain(endpoint);
  });
  it("rejects invalid hashes/accounts/ciphertexts before argument construction", () => {
    const ciphertext = encryptSecretJson(plaintext, recipient);
    expect(() =>
      secretStoreArgs(hash.toUpperCase(), owner, borrower, lender, ciphertext),
    ).toThrow();
    expect(() =>
      secretStoreArgs(hash, "../bad", borrower, lender, ciphertext),
    ).toThrow();
    expect(() =>
      secretStoreArgs(hash, owner, borrower, "*", ciphertext),
    ).toThrow();
    expect(() =>
      secretStoreArgs(hash, owner, borrower, lender, endpoint),
    ).toThrow();
    expect(() =>
      secretStoreArgs(hash, owner, borrower, lender, "AQ=="),
    ).toThrow();
    expect(() =>
      secretStoreArgs(hash + "\n", owner, borrower, lender, ciphertext),
    ).toThrow();
    expect(() =>
      secretStoreArgs(hash, owner + "\n", borrower, lender, ciphertext),
    ).toThrow();
  });
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function cliFixture(mode = "ok") {
  const root = mkdtempSync(join(tmpdir(), "proofcredit-secrets-test-"));
  roots.push(root);
  mkdirSync(join(root, "tooling"));
  mkdirSync(join(root, ".local/rpc"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".local/\n");
  writeFileSync(
    join(root, ".local/rpc/sepolia.env"),
    `ALCHEMY_SEPOLIA_RPC_URL="${endpoint}"\n`,
    { mode: 0o600 },
  );
  const helper = join(root, "tooling/outlayer-secrets.mjs"),
    preload = join(root, "public-fetch-fixture.mjs");
  copyFileSync(
    fileURLToPath(
      new URL("../../../tooling/outlayer-secrets.mjs", import.meta.url),
    ),
    helper,
  );
  writeFileSync(
    preload,
    `import {writeFileSync} from 'node:fs'; globalThis.fetch=async(url,options)=>{writeFileSync(${JSON.stringify(join(root, "request.json"))},JSON.stringify({url,options})); if(${JSON.stringify(mode)}==='throw') throw new Error(${JSON.stringify(endpoint)}); return new Response(${JSON.stringify(JSON.stringify(response))},{status:200,headers:{'content-type':'application/json'}});};`,
  );
  function run(extra: string[] = [], importing = false) {
    // Overriding a flag in a test replaces its one value, never adds ambiguity.
    const flags = new Map([
      ["--hash", hash],
      ["--owner", owner],
      ["--borrower", borrower],
      ["--lender", lender],
      ["--out", ".local/encrypted/args.json"],
    ]);
    const suffix: string[] = [];
    for (let i = 0; i < extra.length; i += 2) {
      if (extra[i] === "--out") flags.set(extra[i], extra[i + 1]);
      else suffix.push(extra[i], extra[i + 1]);
    }
    const args = importing
      ? [
          "--import",
          preload,
          "--input-type=module",
          "-e",
          `await import(${JSON.stringify(helper)})`,
        ]
      : ["--import", preload, helper, ...Array.from(flags).flat(), ...suffix];
    return spawnSync(process.execPath, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 5000,
      env: { PATH: process.env.PATH },
    });
  }
  return { root, run };
}
describe("CLI with isolated synthetic credentials", () => {
  it("does nothing on import even without a credential file", () => {
    const { root, run } = cliFixture();
    rmSync(join(root, ".local/rpc/sepolia.env"));
    const result = run([], true);
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toBe("");
    expect(existsSync(join(root, "request.json"))).toBe(false);
  });
  it("requests only dummy values and exclusively writes mode0600 public ciphertext arguments", () => {
    const { root, run } = cliFixture(),
      result = run();
    expect(result.status).toBe(0);
    const request = readFileSync(join(root, "request.json"), "utf8");
    expect(request).not.toContain(testKey);
    expect(request).not.toContain(endpoint);
    const parsed = JSON.parse(request);
    expect(parsed.url).toBe("https://testnet-api.outlayer.ai/secrets/pubkey");
    expect(parsed.options.redirect).toBe("error");
    expect(JSON.parse(parsed.options.body)).toEqual({
      accessor: { type: "WasmHash", hash },
      owner,
      profile: "proofcredit-rpc-v1",
      secrets_json: '{"ALCHEMY_API_KEY":""}',
    });
    const path = join(root, ".local/encrypted/args.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const output = readFileSync(path, "utf8"),
      data = JSON.parse(output);
    expect(output + result.stdout + result.stderr).not.toContain(testKey);
    expect(output + result.stdout + result.stderr).not.toContain(endpoint);
    expect(data.owner).toBe(owner);
    expect(decrypt(data.store_args.encrypted_secrets_base64)).toEqual(
      plaintext,
    );
    expect(
      data.store_args.access.Logic.conditions[0].Whitelist.accounts,
    ).toEqual([borrower, lender]);
    expect(data.estimate_args).toEqual({ ...data.store_args, owner });
    expect(run().status).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(output);
  });
  it.each([
    "/tmp/escape.json",
    "../escape.json",
    ".local/../escape.json",
    ".local/a/../escape.json",
    ".local/rpc/sepolia.env",
    ".local//escape.json",
    ".local/a%2fescape.json",
    ".local/bad\n/escape.json",
  ])("rejects hostile output path before any request (%s)", (path) => {
    const { root, run } = cliFixture(),
      result = run(["--out", path]);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(testKey);
    expect(existsSync(join(root, "request.json"))).toBe(false);
  });
  it("rejects symlink output parents and missing .local ignore protection", () => {
    const { root, run } = cliFixture();
    mkdirSync(join(root, "outside"));
    symlinkSync(join(root, "outside"), join(root, ".local/encrypted"));
    expect(run().status).toBe(1);
    expect(existsSync(join(root, "request.json"))).toBe(false);
    rmSync(join(root, ".local/encrypted"));
    writeFileSync(join(root, ".gitignore"), "");
    expect(run().status).toBe(1);
    expect(existsSync(join(root, "request.json"))).toBe(false);
  });
  it("redacts transport exceptions containing sensitive values", () => {
    const { root, run } = cliFixture("throw"),
      result = run();
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toBe(
      "Secret preparation failed (redacted)\n",
    );
    expect(existsSync(join(root, ".local/encrypted/args.json"))).toBe(false);
  });
  it("rejects unknown/duplicate flags and malformed configuration without echoing values", () => {
    const { root, run } = cliFixture();
    for (const extra of [
      ["--key", testKey],
      ["--owner", owner],
      ["--url", endpoint],
    ]) {
      const result = run(extra);
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).not.toContain(testKey);
    }
    writeFileSync(
      join(root, ".local/rpc/sepolia.env"),
      `ALCHEMY_SEPOLIA_RPC_URL=${endpoint}\nALCHEMY_SEPOLIA_RPC_URL=${endpoint}\n`,
    );
    expect(run().status).toBe(1);
    expect(existsSync(join(root, "request.json"))).toBe(false);
  });
});
