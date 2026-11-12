import { it, expect } from "vitest";
import { LocalCoordinator } from "../src/local.ts";
it("an unrelated successful bridge receipt cannot hide the financial call own rejected callback", async () => {
  const own = {
    transaction_outcome: {
      outcome: { status: { SuccessReceiptId: "dependency" } },
    },
    receipts_outcome: [],
    status: { SuccessValue: "ZmFsc2U=" },
  };
  const context = {
    transaction: async () => own,
    journal: {
      data: {
        receipts: [
          { status: "success", detail: "unrelated successful mock resume" },
        ],
      },
    },
  };
  await expect(
    LocalCoordinator.prototype.call.call(
      context as never,
      "borrower",
      "controller",
      "request_proof",
    ),
  ).rejects.toThrow("callback rejected");
});
