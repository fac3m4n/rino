import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loopbackUrl } from "./safety.ts";
export const ROOT = resolve(import.meta.dirname, "../../..");
export const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));
export async function rpc(
  url: string,
  method: string,
  params: unknown,
): Promise<any> {
  loopbackUrl(url);
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error(`RPC HTTP ${response.status}`);
  const reader = response.body!.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 2_000_000) {
      await reader.cancel();
      throw Error("RPC response bound");
    }
    parts.push(value);
  }
  const v = JSON.parse(Buffer.concat(parts).toString());
  if (v.error) throw Error(`RPC ${method}: ${JSON.stringify(v.error)}`);
  return v.result;
}
export async function commandIdentity(pid: number): Promise<string> {
  const { stdout } = await promisify(execFile)(
    "/bin/ps",
    ["-p", String(pid), "-o", "lstart=,command="],
    { timeout: 2000, maxBuffer: 8192 },
  );
  if (!stdout.trim()) throw Error("owned process absent");
  return stdout.trim();
}
export class Children {
  readonly all = new Set<ChildProcess>();
  readonly failures: Error[] = [];
  readonly groups = new Set<number>();
  private closed = false;
  private cleanup: Promise<void> | undefined;
  assertOpen() {
    if (this.closed) throw Error("owned children closed");
  }

  spawn(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv = process.env,
    ownGroup = true,
  ): ChildProcess {
    this.assertOpen();
    const child = spawn(command, args, {
      cwd: ROOT,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: ownGroup,
    });
    this.all.add(child);
    if (child.pid && ownGroup) this.groups.add(child.pid);
    child.on("close", () => {
      this.all.delete(child);
      this.pruneGroups();
    });
    child.on("error", (error) => this.failures.push(error));
    // Bound diagnostics without printing command output that could contain secrets.
    let bytes = 0;
    for (const stream of [child.stdout, child.stderr])
      stream?.on("data", (b: Buffer) => {
        bytes += b.length;
        if (bytes > 2_000_000) child.kill("SIGKILL");
      });
    return child;
  }
  private pruneGroups() {
    for (const pid of this.groups) {
      try {
        process.kill(-pid, 0);
      } catch {
        this.groups.delete(pid);
      }
    }
  }
  async stopGroup(pid: number) {
    if (!this.groups.has(pid)) return;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {}
    const end = Date.now() + 2000;
    while (Date.now() < end) {
      this.pruneGroups();
      if (!this.groups.has(pid)) return;
      await sleep(30);
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    this.pruneGroups();
  }
  stop(): Promise<void> {
    this.closed = true;
    this.cleanup ??= this.cleanupChildren();
    return this.cleanup;
  }
  private async cleanupChildren() {
    for (const child of this.all) {
      child.stdin?.end();
      child.kill("SIGTERM");
    }
    this.pruneGroups();
    for (const pid of this.groups) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {}
    }
    const deadline = Date.now() + 3000;
    while ((this.all.size || this.groups.size) && Date.now() < deadline) {
      await sleep(30);
      this.pruneGroups();
    }
    for (const pid of this.groups) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }
    const end = Date.now() + 3000;
    while ((this.all.size || this.groups.size) && Date.now() < end) {
      await sleep(30);
      this.pruneGroups();
    }
    if (this.all.size || this.groups.size)
      throw Error("owned child process cleanup incomplete");
  }
}
async function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close((e) => (e ? reject(e) : resolve(port)));
    });
  });
}
export interface LocalManifest {
  mode: "local";
  sessionId: string;
  dir: string;
  masterPid: number;
  masterIdentity: string;
  anvilPid: number;
  anvilIdentity: string;
  anvilUrl: string;
  anvilInstanceId: string;
  sandboxPid: number;
  sandboxIdentity: string;
  nearUrl: string;
  nearGenesis: string;
  signer: string;
  mpcKey: `0x${string}`;
  mpcPublicKey: string;
  vault: string;
  funder: string;
  borrowerRecipient: string;
  lenderRecipient: string;
}
export async function assertOwned(m: LocalManifest): Promise<void> {
  if (m.mode !== "local") throw Error("local session required");
  loopbackUrl(m.nearUrl);
  loopbackUrl(m.anvilUrl);
  for (const [pid, identity] of [
    [m.masterPid, m.masterIdentity],
    [m.anvilPid, m.anvilIdentity],
    [m.sandboxPid, m.sandboxIdentity],
  ] as const) {
    if ((await commandIdentity(pid)) !== identity)
      throw Error("owned PID identity mismatch");
  }
  if ((await rpc(m.anvilUrl, "eth_chainId", [])) !== "0xaa36a7")
    throw Error("wrong Ethereum network");
  const meta = await rpc(m.anvilUrl, "anvil_metadata", []);
  if (meta.instanceId !== m.anvilInstanceId)
    throw Error("Anvil instance mismatch");
  const genesis = createHash("sha256")
    .update(JSON.stringify(await rpc(m.nearUrl, "genesis_config", [])))
    .digest("hex");
  if (genesis !== m.nearGenesis) throw Error("Sandbox genesis mismatch");
}
export async function startStack(
  options: {
    sandboxBinary?: string;
    children?: Children;
    signal?: AbortSignal;
    afterAnvilStarted?: (info: {
      pid: number;
      url: string;
      dir: string;
    }) => Promise<void>;
  } = {},
): Promise<{
  manifest: LocalManifest;
  children: Children;
  manifestPath: string;
}> {
  const children = options.children ?? new Children();
  const checkStartup = () => {
    children.assertOpen();
    options.signal?.throwIfAborted();
  };
  try {
    checkStartup();
    const dir = resolve(ROOT, ".cache/local-demo", randomUUID());
    await mkdir(dir, { recursive: true, mode: 0o700 });
    checkStartup();
    const port = await unusedPort(),
      anvilUrl = `http://127.0.0.1:${port}`;
    checkStartup();
    const anvil = children.spawn(resolve(ROOT, ".tools/anvil/1.7.1/anvil"), [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--chain-id",
      "11155111",
      "--silent",
    ]);
    if (options.afterAnvilStarted)
      await options.afterAnvilStarted({ pid: anvil.pid!, url: anvilUrl, dir });
    checkStartup();
    const env = {
      ...process.env,
      NEAR_SANDBOX_BIN_PATH: resolve(
        ROOT,
        ".tools/near-sandbox/2.14.0/near-sandbox",
      ),
      TMPDIR: resolve(ROOT, ".cache/sandbox/tmp"),
      NEAR_SANDBOX_LOG: "off",
    };
    const signerPath = resolve(dir, "sandbox-private.json");
    const sandbox = children.spawn(
      options.sandboxBinary ??
        resolve(
          ROOT,
          "target/financial-flow-native/debug/proofcredit-financial-sandbox",
        ),
      [signerPath],
      env,
    );
    const deadline = Date.now() + 60000;
    let near: any;
    while (Date.now() < deadline) {
      checkStartup();
      if (
        children.failures.length ||
        anvil.exitCode !== null ||
        sandbox.exitCode !== null
      )
        throw Error("owned chain startup failed");
      try {
        near = JSON.parse(await readFile(signerPath, "utf8"));
        await rpc(anvilUrl, "eth_chainId", []);
        break;
      } catch {
        await sleep(100);
      }
    }
    checkStartup();
    if (!near) throw Error("chain startup timeout");
    const key = generatePrivateKey(),
      account = privateKeyToAccount(key);
    const { base58 } = await import("@scure/base");
    const mpcPublicKey = `secp256k1:${base58.encode(Buffer.from(account.publicKey.slice(4), "hex"))}`;
    const accounts = await rpc(anvilUrl, "eth_accounts", []);
    // Materialize the prefunded genesis state into an actual canonical header.
    // Anvil's genesis header otherwise reports the empty trie root.
    await rpc(anvilUrl, "evm_mine", []);
    const m: LocalManifest = {
      mode: "local",
      sessionId: randomUUID(),
      dir,
      masterPid: process.pid,
      masterIdentity: await commandIdentity(process.pid),
      anvilPid: anvil.pid!,
      anvilIdentity: await commandIdentity(anvil.pid!),
      anvilUrl,
      anvilInstanceId: (await rpc(anvilUrl, "anvil_metadata", [])).instanceId,
      sandboxPid: sandbox.pid!,
      sandboxIdentity: await commandIdentity(sandbox.pid!),
      nearUrl: near.rpcUrl,
      nearGenesis: createHash("sha256")
        .update(JSON.stringify(await rpc(near.rpcUrl, "genesis_config", [])))
        .digest("hex"),
      signer: near.signer,
      mpcKey: key,
      mpcPublicKey,
      vault: account.address.toLowerCase(),
      funder: accounts[0],
      borrowerRecipient: accounts[1].toLowerCase(),
      lenderRecipient: accounts[2].toLowerCase(),
    };
    checkStartup();
    const manifestPath = resolve(dir, "session-private.json");
    await writeFile(manifestPath, JSON.stringify(m), { mode: 0o600 });
    await chmod(manifestPath, 0o600);
    await assertOwned(m);
    checkStartup();
    return { manifest: m, children, manifestPath };
  } catch (e) {
    await children.stop();
    throw e;
  }
}
export async function loadManifest(path: string): Promise<LocalManifest> {
  const m = JSON.parse(await readFile(path, "utf8")) as LocalManifest;
  await assertOwned(m);
  return m;
}
export async function hashFile(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
