import { afterEach, expect, it, vi } from "vitest";
import {
  assertMarketConfig,
  loadMarkets,
  marketSnapshot,
  parseMarkets,
  requireMarket,
  type MarketCatalog,
} from "../src/markets";
import { configFixture } from "./fixtures";
const primary = {
  id: "primary",
  name: "ETH market",
  apiBase: "/api",
  controllerId: configFixture.near.controllerId,
  networkId: configFixture.near.networkId,
};
const second = {
  ...primary,
  id: "reserve",
  name: "Reserve",
  apiBase: "/api/markets/reserve",
  controllerId: "reserve.test",
};
const catalog: MarketCatalog = { apiVersion: 1, markets: [primary, second] };
afterEach(() => vi.unstubAllGlobals());
it("loads an explicit catalog and never silently selects another market", async () => {
  const paths: string[] = [];
  vi.stubGlobal("fetch", async (url: unknown) => {
    paths.push(String(url));
    return Response.json(catalog);
  });
  expect(await loadMarkets()).toEqual(catalog);
  expect(paths).toEqual(["/api/markets"]);
  expect(requireMarket(catalog, "reserve")).toEqual(second);
  expect(() => requireMarket(catalog, "unknown")).toThrow(/market/i);
});
for (const bad of [
  null,
  {},
  [],
  { apiVersion: 2, markets: [primary] },
  { apiVersion: 1, markets: [] },
  { apiVersion: 1, markets: Array(17).fill(primary) },
  { ...catalog, markets: [second, primary] },
  { ...catalog, markets: [primary, { ...second, id: "../reserve" }] },
  {
    ...catalog,
    markets: [primary, { ...second, apiBase: "https://outside.invalid/api" }],
  },
  { ...catalog, markets: [primary, { ...second, apiBase: "/api" }] },
  {
    ...catalog,
    markets: [primary, { ...second, controllerId: primary.controllerId }],
  },
  { ...catalog, markets: [primary, { ...second, networkId: "mainnet" }] },
  { ...catalog, markets: [primary, { ...second, networkId: "testnet" }] },
  { ...catalog, markets: [primary, { ...second, name: "" }] },
  {
    ...catalog,
    markets: [primary, { ...second, controllerId: "A bad controller" }],
  },
  {
    ...catalog,
    markets: [primary, { ...second, rawManifest: "not public metadata" }],
  },
])
  it(`rejects malformed/cross-bound catalog ${JSON.stringify(bad)}`, () =>
    expect(() => parseMarkets(bad)).toThrow(/market/i));
it("does not turn catalog unavailability into a primary-market fallback", async () => {
  const calls = vi.fn(async () => {
    throw Error("offline");
  });
  vi.stubGlobal("fetch", calls);
  await expect(loadMarkets()).rejects.toThrow();
  expect(calls).toHaveBeenCalledTimes(1);
});
it("forces selected routing and rejects a mismatched config before exposing its state", async () => {
  const paths: string[] = [];
  vi.stubGlobal("fetch", async (url: unknown) => {
    paths.push(String(url));
    return Response.json(
      String(url).includes("config")
        ? configFixture
        : String(url).endsWith("receipts")
          ? []
          : {},
    );
  });
  await expect(marketSnapshot(second, { apiBase: "/api" })).rejects.toThrow(
    /market/i,
  );
  expect(paths.every((path) => path.startsWith("/api/markets/reserve/"))).toBe(
    true,
  );
  expect(() => assertMarketConfig(second, configFixture)).toThrow(/market/i);
});
it("matches the configured eight-market operator bound", () => {
  const markets = [
    primary,
    ...Array.from({ length: 8 }, (_, index) => ({
      ...second,
      id: `reserve-${index}`,
      apiBase: `/api/markets/reserve-${index}`,
      controllerId: `reserve-${index}.test`,
    })),
  ];
  expect(() => parseMarkets({ apiVersion: 1, markets })).toThrow(/market/i);
});
for (const change of [
  { id: "a".repeat(33), apiBase: `/api/markets/${"a".repeat(33)}` },
  { id: "1reserve", apiBase: "/api/markets/1reserve" },
  { name: "x".repeat(65) },
  { name: " Reserve " },
  { name: "Reserve\nnext" },
])
  it(`rejects a descriptor outside the server policy ${JSON.stringify(change)}`, () =>
    expect(() =>
      parseMarkets({
        ...catalog,
        markets: [primary, { ...second, ...change }],
      }),
    ).toThrow(/market/i));
