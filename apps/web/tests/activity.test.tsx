/** Static UI fixtures only; these do not establish public transaction success. */
import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Config, Receipt } from "@proofcredit/coordinator/api";
import { TransactionLink } from "../src/TransactionLink";
import { ActivityTable } from "../src/ActivityTable";
import { OperationPanel } from "../src/OperationPanel";
import { configFixture, operationFixture } from "./fixtures";

const hash = "11111111111111111111111111111111";
const config: Config = {
  ...configFixture,
  mode: "public",
  near: { ...configFixture.near, networkId: "testnet" },
};
const noop = () => {};
const asyncNoop = async () => {};
const receipt: Receipt = {
  id: "ui-fixture",
  chain: "near",
  action: "proof callback",
  status: "rejected",
  hash,
  blockNumber: "42",
  gasUsed: "1",
  feeWei: null,
  detail: "Finalized callback returned false.",
};

// Catches unsafe external anchors and loss of full-hash accessible evidence.
it("opens public transaction evidence safely with the exact hash accessible", () => {
  const markup = renderToStaticMarkup(
    <TransactionLink
      config={config}
      chain="near"
      hash={hash}
      label="View transaction"
    />,
  );
  expect(markup).toContain(`href="https://testnet.nearblocks.io/txns/${hash}"`);
  expect(markup).toContain('target="_blank"');
  expect(markup).toContain('rel="noopener noreferrer"');
  expect(markup).toMatch(new RegExp(`aria-label="[^"]*${hash}[^"]*"`));
});

it("retains local and worker hashes as readable evidence without external links", () => {
  for (const props of [
    { config: configFixture, chain: "near" as const, hash },
    { config, chain: "worker" as const, hash: "worker-job-fixture" },
    { config, chain: "near" as const, hash: "../malformed" },
  ]) {
    const markup = renderToStaticMarkup(<TransactionLink {...props} />);
    expect(markup).toContain(props.hash);
    expect(markup).not.toContain("href=");
  }
  const absent = renderToStaticMarkup(
    <TransactionLink config={config} chain="near" hash={null} />,
  );
  expect(absent).toContain("No transaction hash");
  expect(absent).not.toContain("href=");
});

// Catches optimistic merging, invented fields, and mutating/reordering the source receipts.
it("shows every observed outcome in reverse source order without turning failed callbacks into success", () => {
  const receipts: Receipt[] = [
    receipt,
    { ...receipt, id: "pending", action: "fund", status: "pending" },
    {
      ...receipt,
      id: "uncertain",
      action: "settle",
      status: "uncertain",
      hash: null,
    },
    { ...receipt, id: "success", action: "borrow", status: "success" },
    {
      ...receipt,
      id: "worker",
      chain: "worker",
      action: "prove",
      status: "success",
      hash: null,
    },
  ];
  const markup = renderToStaticMarkup(
    <ActivityTable config={config} receipts={receipts} onOpenEvidence={noop} />,
  );
  const rows = markup.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) ?? [];
  expect(rows).toHaveLength(6);
  expect(rows[1]).toContain("Worker result");
  expect(rows[1]).not.toContain("href=");
  expect(rows[2]).toContain("Verified step");
  expect(rows[3]).toContain("Needs checking");
  expect(rows[4]).toContain("Pending");
  expect(rows[5]).toContain("Failed");
  expect(rows[5]).toContain("Finalized callback returned false.");
  expect(rows[5]).not.toContain("Verified step");
  for (const status of ["success", "pending", "rejected", "uncertain"]) {
    expect(markup).toContain(`data-status="${status}"`);
  }
  expect(markup).toContain("NEAR");
  expect(markup).toContain("Worker");
  expect(markup).toContain("View all evidence");
  expect(markup).not.toMatch(/<th[^>]*>(Amount|Time|Date)<\/th>/);
  expect(markup).not.toContain("Loan closed");
  expect(receipts[0]).toBe(receipt);
});

it("provides an honest empty activity state and evidence access", () => {
  const markup = renderToStaticMarkup(
    <ActivityTable config={undefined} receipts={[]} onOpenEvidence={noop} />,
  );
  expect(markup).toContain("No recorded activity yet.");
  expect(markup).toContain("View all evidence");
  expect(markup).not.toContain("<tbody><tr");
});

// Catches losing recovery controls/observations when adding explorer presentation.
it("adds links beside unresolved recovery evidence while retaining exact hashes and all controls", () => {
  const operation = {
    ...operationFixture,
    steps: [
      {
        ...operationFixture.steps[0],
        hashes: [
          {
            hash,
            status: "hint" as const,
            detail: "Wallet hash; outcome needs checking.",
          },
        ],
      },
    ],
  };
  // Spread allows this RED test to exercise the existing panel before its optional config prop exists.
  const props = {
    config,
    operations: [operation],
    disabled: false,
    onCheck: asyncNoop,
    onHash: asyncNoop,
    onContinue: asyncNoop,
    onImport: asyncNoop,
    onError: noop,
  };
  const markup = renderToStaticMarkup(<OperationPanel {...props} />);
  expect(markup).toContain(`href="https://testnet.nearblocks.io/txns/${hash}"`);
  expect(markup).toContain(`>${hash}</`);
  expect(markup).toContain('aria-label="Operation recovery"');
  expect(markup).toContain("Submission needs checking.");
  expect(markup).toContain("Unverified transaction hint:");
  expect(markup).toContain("Attach hash and check");
  expect(markup).toContain("Check operation");
  expect(markup).toContain("Continue after fresh check");
  expect(markup).toContain("Import historical receipt");
  expect(markup).not.toContain("<details><summary>prove");
});
