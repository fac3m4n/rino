export function parseAlchemyEndpoint(value: unknown): {
  url: string;
  key: string;
};
export function validatePubkeyResponse(
  response: unknown,
  hash: string,
  owner: string,
): Uint8Array;
export function encryptSecretJson(
  plaintext: Uint8Array,
  pubkey: Uint8Array,
): string;
export interface SecretStoreArguments {
  readonly accessor: { readonly WasmHash: { readonly hash: string } };
  readonly profile: "rino-rpc-v1";
  readonly encrypted_secrets_base64: string;
  readonly access: {
    readonly Logic: {
      readonly operator: "And";
      readonly conditions: readonly [
        {
          readonly Whitelist: { readonly accounts: readonly [string, string] };
        },
        {
          readonly Predecessor: {
            readonly condition: {
              readonly Whitelist: { readonly accounts: readonly [string] };
            };
          };
        },
      ];
    };
  };
  readonly vault_id: null;
}
export function secretStoreArgs(
  hash: string,
  owner: string,
  borrower: string,
  lender: string,
  ciphertext: string,
): SecretStoreArguments;
