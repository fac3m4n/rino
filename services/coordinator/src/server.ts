import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { randomBytes } from "node:crypto";
import { access, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LocalCoordinator, PINS } from "./local.ts";
import { PublicCoordinator, TESTNET_RPC_URL } from "./public.ts";
import { ROOT, loadManifest, sleep } from "./processes.ts";
import { guardRequest, guardTransport, parseAction } from "./safety.ts";
import {
  parseOperationRequest,
  parseOperationObservation,
  parseOperationImport,
  parseEmptyObject,
} from "./operations.ts";
import type { Config, State, ActionResult, WalletAction } from "./api.ts";
const EMPTY: State = {
  apiVersion: 1,
  ready: false,
  market: null,
  settlement: null,
  proofStatus: null,
  evidence: null,
  ethereum: null,
  totalSupplyUnits: null,
  nearTimeSeconds: null,
  busy: false,
  pendingReason:
    "Public deployment and funding prerequisites have not been configured",
};
export async function createApp(options: {
  engine?: LocalCoordinator;
  publicEngine?: PublicCoordinator;
  origin: string;
}) {
  const app = Fastify({
    logger: false,
    bodyLimit: 2048,
    requestTimeout: 180000,
    connectionTimeout: 20000,
  });
  const token = randomBytes(32).toString("hex");
  const engine = options.engine;
  const publicEngine = options.publicEngine;
  const config: Config = {
    apiVersion: 1,
    ...(publicEngine?.operations
      ? { capabilities: { operations: true as const } }
      : {}),
    mode: engine ? "local" : "public",
    ready: !!engine,
    readinessErrors: engine
      ? []
      : [
          "No reviewed public deployment manifest, published worker URL or funded testnet accounts configured",
        ],
    csrfToken: token,
    near: {
      networkId: engine ? "sandbox" : "testnet",
      rpcUrl: engine?.manifest.nearUrl ?? TESTNET_RPC_URL,
      controllerId: engine
        ? "controller"
        : (publicEngine?.deployment.controllerId ?? ""),
      borrowerId: engine
        ? "borrower"
        : (publicEngine?.deployment.borrowerId ?? ""),
      lenderId: engine ? "lender" : (publicEngine?.deployment.lenderId ?? ""),
    },
    ethereum: {
      chainId: "11155111",
      name: engine
        ? "Owned local Anvil (Sepolia chain ID)"
        : "Ethereum Sepolia",
      rpcUrl: engine?.manifest.anvilUrl ?? null,
    },
    authority: engine
      ? [
          "Owned NEAR Sandbox; 120 second term",
          "Generated local mock MPC key and local executor; no public OutLayer/MPC/TEE claim",
          "Two synthetic TLS provider routes share one owned Anvil",
          "Anvil finalized tags are development assumptions; developer full-access NEAR keys remain trusted",
        ]
      : [
          "Public mode holds no borrower, lender or vault signing key",
          "Financial calls require the connected participant wallet",
          "Public OutLayer/MPC, two fixed RPC operators and developer account keys remain trusted",
        ],
    termSeconds: engine ? "120" : "86400",
    artifactHashes: {
      ...(engine ? PINS : (publicEngine?.artifactHashes ?? PINS)),
    },
  };
  app.addHook("onRequest", async (req, reply) => {
    if (req.headers.host !== new URL(options.origin).host) {
      await reply
        .code(403)
        .send({ error: "HOST_DENIED", message: "Unexpected Host" });
      return;
    }
    reply
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer");
    if (req.headers.origin && req.headers.origin !== options.origin) {
      await reply
        .code(403)
        .send({ error: "ORIGIN_DENIED", message: "Unexpected Origin" });
      return;
    }
  });
  app.get("/api/config", async (req) => {
    if (publicEngine) {
      const errors = await publicEngine.readiness({
        fresh: (req.query as { fresh?: string }).fresh === "1",
      });
      return { ...config, ready: errors.length === 0, readinessErrors: errors };
    }
    return config;
  });
  app.get("/api/state", async (req) => {
    if (engine) return engine.state();
    if (publicEngine) {
      try {
        return await publicEngine.state({
          fresh: (req.query as { fresh?: string }).fresh === "1",
        });
      } catch (e) {
        return {
          ...EMPTY,
          pendingReason:
            e instanceof Error ? e.message : "Public readiness failure",
        };
      }
    }
    return EMPTY;
  });
  app.get(
    "/api/receipts",
    async () =>
      engine?.journal.data.receipts ??
      publicEngine?.operations?.receipts() ??
      [],
  );
  app.get(
    "/api/operations",
    async () => publicEngine?.operations?.list() ?? [],
  );
  const operationPost = <T>(
    path: string,
    parser: (body: unknown) => T,
    run: (
      service: NonNullable<typeof publicEngine>["operations"],
      id: string,
      body: T,
    ) => Promise<unknown>,
  ) => {
    app.post(path, async (req, reply) => {
      try {
        guardTransport({
          host: req.headers.host ?? "",
          origin: String(req.headers.origin ?? ""),
          contentType: String(req.headers["content-type"] ?? ""),
          csrf: String(req.headers["x-rino-csrf"] ?? ""),
          expectedOrigin: options.origin,
          expectedCsrf: token,
          body: req.body,
        });
        const body = parser(req.body);
        const id = (req.params as { id?: string }).id ?? "";
        if (
          id &&
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            id,
          )
        )
          throw Error("invalid operation id");
        if (!publicEngine?.operations)
          return reply.code(409).send({
            error: "PUBLIC_NOT_READY",
            message: "Public operation recovery unavailable",
          });
        return await run(publicEngine.operations, id, body);
      } catch {
        return reply.code(400).send({
          error: "ACTION_REJECTED",
          message:
            "Public operation request rejected; review persisted operation evidence",
        });
      }
    });
  };
  operationPost(
    "/api/operations",
    parseOperationRequest,
    (service, _id, body) => service.create(body),
  );
  operationPost(
    "/api/operations/import",
    parseOperationImport,
    (service, _id, body) => service.import(body),
  );
  operationPost(
    "/api/operations/:id/observe",
    parseOperationObservation,
    (service, id, body) => service.observe(id, body),
  );
  operationPost(
    "/api/operations/:id/reconcile",
    parseEmptyObject,
    (service, id) => service.reconcile(id),
  );
  operationPost(
    "/api/operations/:id/continue",
    parseEmptyObject,
    (service, id) => service.continue(id),
  );
  app.post(
    "/api/actions",
    async (req, reply): Promise<ActionResult | unknown> => {
      try {
        guardRequest({
          host: req.headers.host ?? "",
          origin: String(req.headers.origin ?? ""),
          contentType: String(req.headers["content-type"] ?? ""),
          csrf: String(req.headers["x-rino-csrf"] ?? ""),
          expectedOrigin: options.origin,
          expectedCsrf: token,
          body: req.body,
        });
        const action = parseAction(req.body);
        if (engine) return await engine.action(action);
        if (publicEngine) return await publicEngine.action(action);
        return reply.code(409).send({
          error: "PUBLIC_NOT_READY",
          message: config.readinessErrors.join("; "),
        });
      } catch (e) {
        return reply.code(400).send({
          error: "ACTION_REJECTED",
          message: e instanceof Error ? e.message : "Action rejected",
        });
      }
    },
  );
  try {
    await access(resolve(ROOT, "apps/web/dist/index.html"));
    await app.register(fastifyStatic, {
      root: resolve(ROOT, "apps/web/dist"),
      prefix: "/",
    });
    app.setNotFoundHandler(async (_req, reply) => reply.sendFile("index.html"));
  } catch {
    app.get("/", async () => ({
      message: "Build the interface with npm run build:web",
      config: "/api/config",
    }));
  }
  return app;
}
export async function runServer() {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw Error("invalid local port");
  const mode = process.env.RINO_MODE ?? "public";
  if (!["local", "public"].includes(mode))
    throw Error("explicit local/public mode required");
  const engine =
    mode === "local"
      ? await LocalCoordinator.open(
          await loadManifest(process.env.RINO_SESSION ?? ""),
        )
      : undefined;
  if (process.env.RINO_LAB_FAULT) {
    if (
      !engine ||
      process.env.RINO_LAB_FAULT !== "lost-broadcast-response-once"
    )
      throw Error("local lab fault configuration rejected");
    engine.labLoseNextBroadcastResponse = true;
  }
  const origin = `http://127.0.0.1:${port}`;
  const publicEngine =
    mode === "public"
      ? await PublicCoordinator.fromFile(process.env.RINO_PUBLIC_MANIFEST)
      : undefined;
  const app = await createApp({ engine, publicEngine, origin });
  const stop = async () => {
    await engine?.children.stop();
    await Promise.race([app.close(), sleep(2000)]);
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await app.listen({ host: "127.0.0.1", port });
  if (engine)
    await writeFile(
      resolve(engine.manifest.dir, "coordinator-public.json"),
      JSON.stringify({ pid: process.pid, url: origin }),
      { mode: 0o600 },
    );
  console.log(`Rino coordinator ready ${origin}`);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  runServer().catch(() => {
    console.error("Coordinator startup failed; no fallback started");
    process.exitCode = 1;
  });
