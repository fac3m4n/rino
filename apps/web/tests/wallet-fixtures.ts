/** Controlled injected RPC only: never contacts a chain or uses a private key. Self-contained for page.addInitScript. */
export function installFundingProvider(mode: string) {
  const account = "0x1111111111111111111111111111111111111111";
  const vault = "0x1234567890123456789012345678901234567890";
  const original = `0x${"a".repeat(64)}`;
  const replacement = `0x${"b".repeat(64)}`;
  const blockHash = `0x${"c".repeat(64)}`;
  let sends = 0;
  let sentValue = "0x1aa535d3d0c0000";
  const requests: string[] = [];
  const tx = (hash: string, changed = false) => ({
    hash,
    from: account,
    to: changed ? account : vault,
    value: changed ? "0x0" : sentValue,
    input: "0x",
    nonce: "0x0",
    chainId: "0xaa36a7",
    type: "0x2",
    gas: "0x5208",
    gasPrice: "0x1",
    maxFeePerGas: "0x1",
    maxPriorityFeePerGas: "0x1",
    accessList: [],
    blockHash: hash === original ? null : blockHash,
    blockNumber: hash === original ? null : "0x1",
    transactionIndex: "0x0",
    v: "0x0",
    r: "0x1",
    s: "0x1",
    yParity: "0x0",
  });
  const receipt = (hash: string) => ({
    transactionHash: hash,
    blockHash,
    blockNumber: "0x1",
    from: account,
    to: mode === "cancel" ? account : vault,
    transactionIndex: "0x0",
    cumulativeGasUsed: "0x5208",
    gasUsed: "0x5208",
    effectiveGasPrice: "0x1",
    contractAddress: null,
    logs: [],
    logsBloom: `0x${"0".repeat(512)}`,
    status: mode === "revert" ? "0x0" : "0x1",
    type: "0x2",
  });
  const provider = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      requests.push(method);
      switch (method) {
        case "eth_chainId":
          return "0xaa36a7";
        case "eth_accounts":
        case "eth_requestAccounts":
          return [account];
        case "eth_sendTransaction": {
          sends++;
          if (mode === "reject")
            throw Object.assign(new Error("User rejected request"), {
              code: 4001,
            });
          sentValue = (params?.[0] as { value: string }).value;
          return original;
        }
        case "eth_getTransactionReceipt":
          if (
            mode === "timeout" ||
            ((mode === "cancel" || mode === "speedup") &&
              params?.[0] === original)
          )
            return null;
          return receipt(String(params?.[0]));
        case "eth_blockNumber":
          return "0x1";
        case "eth_getTransactionByHash":
          return tx(
            String(params?.[0]),
            mode === "cancel" && params?.[0] === replacement,
          );
        case "eth_getBlockByNumber":
          return {
            hash: blockHash,
            number: "0x1",
            transactions: [tx(replacement, mode === "cancel")],
          };
        default:
          throw new Error(`Unexpected controlled RPC ${method}`);
      }
    },
  };
  Object.assign(globalThis, {
    ethereum: provider,
    walletFixture: {
      get sends() {
        return sends;
      },
      requests,
      original,
      replacement,
      get sentValue() {
        return sentValue;
      },
    },
  });
  return provider;
}
