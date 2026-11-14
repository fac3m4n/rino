import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Config, MarketDescriptor } from "./api.ts";
import type { LocalCoordinator } from "./local.ts";
import type { PublicCoordinator } from "./public.ts";
export const MAX_MARKETS = 8;
export interface MarketBinding {
  engine?: LocalCoordinator;
  publicEngine?: PublicCoordinator;
}
export interface RegisteredMarket extends MarketBinding {
  id: string;
  name: string;
}
export type MarketDefinition = { id: string; name: string } & (
  { manifestPath: string } | { sessionPath: string }
);
function metadata(
  value: unknown,
): asserts value is { id: string; name: string } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid configured market");
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    !/^[a-z][a-z0-9-]{0,31}$/.test(record.id) ||
    record.id === "primary"
  )
    throw Error("Invalid configured market id");
  if (
    typeof record.name !== "string" ||
    record.name.length < 1 ||
    record.name.length > 64 ||
    record.name !== record.name.trim() ||
    /[\u0000-\u001f\u007f]/.test(record.name)
  )
    throw Error("Invalid configured market name");
}
export function registerMarkets(
  primary: MarketBinding,
  additional: RegisteredMarket[] = [],
): RegisteredMarket[] {
  if (!Array.isArray(additional) || additional.length >= MAX_MARKETS)
    throw Error("Configured market capacity exceeded");
  if (primary.engine && primary.publicEngine)
    throw Error("Ambiguous primary market engine");
  const local = !!primary.engine;
  const ids = new Set<string>();
  const controllers = new Set<string>();
  const markets: RegisteredMarket[] = [
    { id: "primary", name: "ETH market", ...primary },
    ...additional,
  ];
  for (const [index, market] of markets.entries()) {
    if (index > 0) {
      if (!market || typeof market !== "object")
        throw Error("Invalid configured market");
      metadata(market);
      if (!!market.engine === !!market.publicEngine)
        throw Error("Configured market requires one engine");
    }
    if (ids.has(market.id)) throw Error("Duplicate configured market id");
    ids.add(market.id);
    if (!!market.engine !== local)
      throw Error("Configured market networks cannot be mixed");
    const controller = market.engine
      ? "controller"
      : market.publicEngine?.deployment.controllerId;
    if (index > 0 && !controller)
      throw Error("Configured market controller is required");
    if (controller) {
      const identity = `${local ? "sandbox" : "testnet"}:${controller}`;
      if (controllers.has(identity))
        throw Error("Duplicate configured controller");
      controllers.add(identity);
    }
  }
  return markets;
}
export function marketDescriptor(
  market: RegisteredMarket,
  config: Config,
): MarketDescriptor {
  return {
    id: market.id,
    name: market.name,
    apiBase: market.id === "primary" ? "/api" : `/api/markets/${market.id}`,
    controllerId: config.near.controllerId,
    networkId: config.near.networkId,
  };
}
/** Operator-owned local file only; never accepts paths or hosts from HTTP. */
export async function readMarketDefinitions(
  file: string | undefined,
  mode: Config["mode"],
): Promise<MarketDefinition[]> {
  if (!file) return [];
  if (!["local", "public"].includes(mode))
    throw Error("Configured market mode rejected");
  const handle = await open(file, "r");
  let content: string;
  try {
    if ((await handle.stat()).size > 16384)
      throw Error("Configured market file exceeds capacity");
    const buffer = Buffer.alloc(16385);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16384)
      throw Error("Configured market file exceeds capacity");
    content = buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
  const entries: unknown = JSON.parse(content);
  if (!Array.isArray(entries) || entries.length >= MAX_MARKETS)
    throw Error("Configured market capacity exceeded");
  const ids = new Set<string>(),
    paths = new Set<string>();
  return entries.map((entry: unknown) => {
    metadata(entry);
    const key = mode === "public" ? "manifestPath" : "sessionPath";
    const path = (entry as Record<string, unknown>)[key];
    if (
      Object.keys(entry).sort().join(",") !==
        ["id", "name", key].sort().join(",") ||
      typeof path !== "string" ||
      path.length < 1 ||
      path.length > 1024 ||
      path !== path.trim() ||
      /[\u0000-\u001f\u007f]/.test(path)
    )
      throw Error("Configured market file schema rejected");
    const resolved = resolve(dirname(resolve(file)), path);
    if (ids.has(entry.id) || paths.has(resolved))
      throw Error("Duplicate configured market identity");
    ids.add(entry.id);
    paths.add(resolved);
    return {
      id: entry.id,
      name: entry.name,
      [key]: resolved,
    } as MarketDefinition;
  });
}
