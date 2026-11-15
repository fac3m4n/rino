import type { NearConnector } from "@hot-labs/near-connect";

export interface NearWalletOption {
  id: string;
  name: string;
}

export async function loadNearWalletOptions(
  sdk: NearConnector,
): Promise<NearWalletOption[]> {
  await sdk.whenManifestLoaded;
  const ids = new Set<string>();
  return sdk.availableWallets.map(({ manifest }) => {
    if (
      typeof manifest.id !== "string" ||
      !manifest.id.trim() ||
      manifest.id.length > 128 ||
      ids.has(manifest.id) ||
      typeof manifest.name !== "string" ||
      !manifest.name.trim() ||
      manifest.name.length > 80
    )
      throw new Error("Wallet list is invalid. Refresh the wallet list.");
    ids.add(manifest.id);
    return { id: manifest.id, name: manifest.name };
  });
}
