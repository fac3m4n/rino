export type PublicArtifactHashes = Readonly<{
  collateral: string;
  settlement: string;
  controller: string;
}>;

/** Reviewed deployment bindings for existing version 2 manifests, independent of local builds. */
export const REVIEWED_V2_ARTIFACTS: PublicArtifactHashes = Object.freeze({
  collateral:
    "fbd5e0664aa18b3fe11f07d383cfbb73ef9eeff9d7747f623b33f09c4570f96e",
  settlement:
    "a0efb7959a1f227d7e81579820bf3b3cec9804d94e5095fa6a90b301052e19c7",
  controller:
    "f46bb1dedeca51f8f7820d5c74e30e0484421299adb3d6715545741ad1115497",
});

export function publicArtifactHashes(
  version: 2 | 3,
  artifacts: unknown,
  controllerCodeHash: string,
): PublicArtifactHashes {
  if (version === 2) return REVIEWED_V2_ARTIFACTS;
  if (
    !artifacts ||
    typeof artifacts !== "object" ||
    Array.isArray(artifacts) ||
    Object.keys(artifacts).sort().join(",") !==
      "collateral,controller,settlement" ||
    Object.values(artifacts).some(
      (hash) => typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash),
    )
  )
    throw Error("public deployment artifact hashes rejected");
  const selected = artifacts as PublicArtifactHashes;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = BigInt(`0x${selected.controller}`);
  let encoded = "";
  while (value > 0n) {
    encoded = alphabet[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  const leadingZeroes = selected.controller.match(/^(?:00)*/)?.[0].length ?? 0;
  encoded = "1".repeat(leadingZeroes / 2) + encoded;
  if (encoded !== controllerCodeHash)
    throw Error("public controller artifact differs from NEAR code hash");
  return Object.freeze({ ...selected });
}
