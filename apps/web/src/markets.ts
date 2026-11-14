import type { Config } from "@rino/coordinator/api";
import {
  readApi,
  snapshot,
  type RequestOptions,
  type Snapshot,
} from "./client";

export interface MarketDescriptor {
  id: string;
  name: string;
  apiBase: string;
  controllerId: string;
  networkId: Config["near"]["networkId"];
}
export interface MarketCatalog {
  apiVersion: 1;
  markets: MarketDescriptor[];
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function invalid(): never {
  throw Error(
    "Configured market data is invalid. Financial actions remain paused.",
  );
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
}
/** A catalog chooses an endpoint; it must never redirect a wallet or its CSRF. */
export function parseMarkets(raw: unknown): MarketCatalog {
  if (!object(raw)) invalid();
  exactKeys(raw, ["apiVersion", "markets"]);
  if (
    raw.apiVersion !== 1 ||
    !Array.isArray(raw.markets) ||
    raw.markets.length < 1 ||
    raw.markets.length > 8
  )
    invalid();
  const ids = new Set<string>(),
    controllers = new Set<string>();
  let network: unknown;
  const markets = raw.markets.map((value, index): MarketDescriptor => {
    if (!object(value)) invalid();
    exactKeys(value, ["id", "name", "apiBase", "controllerId", "networkId"]);
    const { id, name, apiBase, controllerId, networkId } = value;
    if (
      typeof id !== "string" ||
      !/^[a-z][a-z0-9-]{0,31}$/.test(id) ||
      ids.has(id) ||
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 64 ||
      name !== name.trim() ||
      /[\u0000-\u001f\u007f]/.test(name) ||
      (networkId !== "sandbox" && networkId !== "testnet") ||
      (index === 0
        ? id !== "primary" || apiBase !== "/api"
        : id === "primary" || apiBase !== `/api/markets/${id}`) ||
      typeof controllerId !== "string" ||
      !(
        (index === 0 && controllerId === "") ||
        (controllerId.length >= 2 &&
          controllerId.length <= 64 &&
          /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(controllerId))
      )
    )
      invalid();
    network ??= networkId;
    const identity = `${networkId}:${controllerId}`;
    if (network !== networkId || controllers.has(identity)) invalid();
    ids.add(id);
    controllers.add(identity);
    return { id, name, apiBase: apiBase as string, controllerId, networkId };
  });
  return { apiVersion: 1, markets };
}
export async function loadMarkets(
  options: Pick<RequestOptions, "signal" | "timeoutMs"> = {},
): Promise<MarketCatalog> {
  return parseMarkets(
    await readApi("markets", { ...options, apiBase: "/api" }),
  );
}
export function requireMarket(
  catalog: MarketCatalog,
  id: string,
): MarketDescriptor {
  const market = catalog.markets.find((market) => market.id === id);
  if (!market)
    throw Error(
      "The selected market is not configured. Choose an available position.",
    );
  return market;
}
export function assertMarketConfig(
  market: MarketDescriptor,
  config: Config,
): void {
  if (
    config.apiVersion !== 1 ||
    config.near.controllerId !== market.controllerId ||
    config.near.networkId !== market.networkId
  )
    invalid();
}
export async function marketSnapshot(
  market: MarketDescriptor,
  options: RequestOptions = {},
): Promise<Snapshot> {
  const result = await snapshot({ ...options, apiBase: market.apiBase });
  assertMarketConfig(market, result.config);
  return result;
}
