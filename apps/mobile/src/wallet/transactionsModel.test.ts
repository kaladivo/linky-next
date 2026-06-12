/**
 * #43 model tests — the issue's golden-test agreement: no wire formats
 * here, so the recording/merge logic is unit-tested thoroughly instead.
 * Focus per the issue: error records are NEVER discarded, the issued-spend
 * merge produces ONE history item, and the request-status mapping
 * (pending/paid/declined) is correct ahead of #45's data.
 */
import type { TransactionRecord } from "@linky/evolu-store";
import { describe, expect, it } from "vitest";

import {
  buildSupportDump,
  buildTransactionHistory,
  formatCompactValue,
  parseTransactionDetails,
  transactionDetailSections,
  transactionStatusPill,
  transactionTitle,
  ISSUED_TOKEN_ID_DETAIL,
  REQUEST_ID_DETAIL,
  REQUEST_TEXT_DETAIL,
  REQUEST_TRANSACTION_METHOD,
  USED_TOKEN_IDS_DETAIL,
} from "./transactionsModel";

let nextId = 0;

const record = (overrides: Partial<TransactionRecord> = {}): TransactionRecord => ({
  id: `tx-${String(++nextId).padStart(3, "0")}`,
  happenedAtSec: 1_000_000 + nextId,
  direction: "out",
  status: "completed",
  category: "lightning",
  method: "invoice",
  phase: null,
  amount: 1000,
  feeAmount: null,
  unit: "sat",
  mintUrl: "https://mint.example.org",
  contactId: null,
  note: null,
  error: null,
  detailsJson: null,
  createdAt: "2026-06-12T00:00:00.000Z",
  updatedAt: null,
  ...overrides,
});

const json = (value: Record<string, unknown>): string => JSON.stringify(value);

describe("buildTransactionHistory ordering", () => {
  it("sorts newest first by happenedAtSec", () => {
    const older = record({ happenedAtSec: 100 });
    const newer = record({ happenedAtSec: 200 });
    const items = buildTransactionHistory([older, newer]);
    expect(items.map((item) => item.record.id)).toEqual([newer.id, older.id]);
  });
});

describe("issued-spend merge (tx.merge-issued-token-spend)", () => {
  const emit = () =>
    record({
      direction: "out",
      category: "cashu",
      method: "token",
      happenedAtSec: 100,
      detailsJson: json({ [ISSUED_TOKEN_ID_DETAIL]: "token-row-1" }),
    });
  const spend = (status: string) =>
    record({
      direction: "out",
      category: "contacts",
      method: "chat",
      status,
      happenedAtSec: 200,
      detailsJson: json({ [USED_TOKEN_IDS_DETAIL]: ["token-row-1"] }),
    });

  it("emit-then-send renders as ONE history item (the spend), emit folded in", () => {
    const emitRow = emit();
    const spendRow = spend("completed");
    const items = buildTransactionHistory([emitRow, spendRow]);
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item?.record.id).toBe(spendRow.id);
    expect(item?.mergedIds).toEqual([emitRow.id]);
    // The emit half's details fold into the merged item.
    expect(item?.details?.[ISSUED_TOKEN_ID_DETAIL]).toBe("token-row-1");
    expect(item?.details?.[USED_TOKEN_IDS_DETAIL]).toEqual(["token-row-1"]);
  });

  it("a FAILED spend never hides the emit row (error records stay)", () => {
    const items = buildTransactionHistory([emit(), spend("failed")]);
    expect(items).toHaveLength(2);
  });

  it("a failed emit row is never merged away", () => {
    const failedEmit = record({
      direction: "out",
      category: "cashu",
      method: "token",
      status: "failed",
      error: "mint down",
      happenedAtSec: 100,
      detailsJson: json({ [ISSUED_TOKEN_ID_DETAIL]: "token-row-1" }),
    });
    const items = buildTransactionHistory([failedEmit, spend("completed")]);
    expect(items.map((item) => item.record.id)).toContain(failedEmit.id);
  });

  it("an emit row whose token is unspent stays visible", () => {
    const emitRow = emit();
    const items = buildTransactionHistory([emitRow]);
    expect(items).toHaveLength(1);
    expect(items[0]?.record.id).toBe(emitRow.id);
  });
});

describe("request status (tx.request-status, data from #45)", () => {
  const request = (requestId: string) =>
    record({
      direction: "in",
      category: "cashu",
      method: REQUEST_TRANSACTION_METHOD,
      status: "pending",
      happenedAtSec: 100,
      detailsJson: json({
        [REQUEST_ID_DETAIL]: requestId,
        [REQUEST_TEXT_DETAIL]: "Lunch split",
      }),
    });

  it("maps an unresolved request to pending", () => {
    const items = buildTransactionHistory([request("req-1")]);
    expect(items[0]?.requestStatus).toBe("pending");
    expect(transactionStatusPill(items[0]!)).toEqual({
      tone: "muted",
      labelKey: "transactionPending",
    });
  });

  it("merges the completed fulfillment and maps to paid", () => {
    const requestRow = request("req-1");
    const fulfillment = record({
      direction: "in",
      category: "cashu",
      method: "token",
      status: "completed",
      happenedAtSec: 200,
      detailsJson: json({ [REQUEST_ID_DETAIL]: "req-1", lightningMemo: "paid you" }),
    });
    const items = buildTransactionHistory([requestRow, fulfillment]);
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item?.record.id).toBe(requestRow.id);
    expect(item?.requestStatus).toBe("paid");
    expect(item?.mergedIds).toEqual([fulfillment.id]);
    expect(item?.details?.["lightningMemo"]).toBe("paid you");
    // The DERIVED status governs the pill even though the row is "pending".
    expect(transactionStatusPill(item!)).toEqual({
      tone: "ok",
      labelKey: "paymentRequestStatusPaid",
    });
  });

  it("maps a declined request via the #45 seam set", () => {
    const items = buildTransactionHistory([request("req-1")], new Set(["req-1"]));
    expect(items[0]?.requestStatus).toBe("declined");
    expect(transactionStatusPill(items[0]!)).toEqual({
      tone: "danger",
      labelKey: "paymentRequestStatusDeclined",
    });
  });

  it("keeps FAILED fulfillment attempts visible (PoC divergence, contract)", () => {
    const requestRow = request("req-1");
    const failedAttempt = record({
      direction: "in",
      category: "cashu",
      method: "token",
      status: "failed",
      error: "accept failed",
      happenedAtSec: 150,
      detailsJson: json({ [REQUEST_ID_DETAIL]: "req-1" }),
    });
    const items = buildTransactionHistory([requestRow, failedAttempt]);
    expect(items.map((item) => item.record.id)).toContain(failedAttempt.id);
    // No completed fulfillment → the request still reads pending.
    expect(items.find((item) => item.record.id === requestRow.id)?.requestStatus).toBe("pending");
  });
});

describe("error records (tx.record contract)", () => {
  it("failed rows keep their row and surface the error user-facing", () => {
    const failed = record({ status: "failed", error: "MintProtocolError: 502" });
    const items = buildTransactionHistory([failed]);
    expect(items).toHaveLength(1);
    expect(transactionStatusPill(items[0]!)).toEqual({
      tone: "danger",
      labelKey: "transactionFailed",
    });
    const sections = transactionDetailSections(items[0]!);
    expect(sections.user.some((f) => f.labelKey === "transactionDetailError")).toBe(true);
  });

  it("pending rows show the pending pill", () => {
    const items = buildTransactionHistory([record({ status: "pending" })]);
    expect(transactionStatusPill(items[0]!)).toEqual({
      tone: "muted",
      labelKey: "transactionPending",
    });
  });

  it("completed rows show no pill (PoC parity)", () => {
    const items = buildTransactionHistory([record({ status: "completed" })]);
    expect(transactionStatusPill(items[0]!)).toBeNull();
  });
});

describe("titles", () => {
  const itemOf = (row: TransactionRecord) => buildTransactionHistory([row])[0]!;

  it("note wins over the flow label, contact over the fallback", () => {
    expect(transactionTitle(itemOf(record({ note: "Rent" })), null)).toEqual({
      kind: "text",
      text: "Rent",
    });
    expect(transactionTitle(itemOf(record()), "Bob")).toEqual({ kind: "text", text: "Bob" });
  });

  it("maps lightning flows per direction/method", () => {
    expect(transactionTitle(itemOf(record({ direction: "in", method: "invoice" })), null)).toEqual(
      { kind: "key", key: "transactionTopupInvoice" },
    );
    expect(
      transactionTitle(itemOf(record({ direction: "out", method: "lnaddress" })), null),
    ).toEqual({ kind: "key", key: "transactionPaidLightningAddress" });
  });

  it("maps consolidation (#42) and cashu fallbacks", () => {
    expect(
      transactionTitle(itemOf(record({ category: "cashu", method: "swap" })), null),
    ).toEqual({ kind: "key", key: "transactionCashuSwap" });
    expect(
      transactionTitle(
        itemOf(record({ category: "cashu", method: "token", direction: "out" })),
        null,
      ),
    ).toEqual({ kind: "key", key: "transactionCashuIssued" });
  });

  it("labels request rows as payment requests", () => {
    const requestRow = record({
      direction: "in",
      method: REQUEST_TRANSACTION_METHOD,
      detailsJson: json({ [REQUEST_ID_DETAIL]: "r", [REQUEST_TEXT_DETAIL]: "t" }),
    });
    expect(transactionTitle(buildTransactionHistory([requestRow])[0]!, "Bob")).toEqual({
      kind: "key",
      key: "requestPaymentLabel",
    });
  });
});

describe("detail sections + support dump (tx.details, #59-pending split)", () => {
  it("compacts long invoices/preimages but copies the full value", () => {
    const invoice = `lnbc100u1${"p".repeat(60)}`;
    const row = record({ detailsJson: json({ lightningInvoice: invoice }) });
    const sections = transactionDetailSections(buildTransactionHistory([row])[0]!);
    const entry = sections.support.find((f) => f.labelKey === "transactionDetailLightningInvoice");
    expect(entry?.value).toBe(formatCompactValue(invoice));
    expect(entry?.copyValue).toBe(invoice);
    expect(formatCompactValue("short")).toBe("short");
  });

  it("surfaces topup quote payloads (invoice/quoteId) as support fields", () => {
    const row = record({
      direction: "in",
      detailsJson: json({ invoice: `lnbc1${"q".repeat(40)}`, quoteId: "quote-1" }),
    });
    const sections = transactionDetailSections(buildTransactionHistory([row])[0]!);
    expect(sections.support.some((f) => f.labelKey === "transactionDetailLightningInvoice")).toBe(
      true,
    );
    expect(sections.support.some((f) => f.labelKey === "transactionDetailQuoteId")).toBe(true);
  });

  it("NEVER leaks non-whitelisted detail keys (defense in depth vs secrets)", () => {
    const row = record({
      detailsJson: json({
        token: "cashuBSECRET",
        proofs: [{ secret: "s" }],
        nsec: "nsec1evil",
        lightningMemo: "ok-field",
      }),
    });
    const item = buildTransactionHistory([row])[0]!;
    const sections = transactionDetailSections(item);
    const allValues = [...sections.user, ...sections.support]
      .map((f) => `${f.value}|${f.copyValue ?? ""}`)
      .join(" ");
    expect(allValues).not.toContain("cashuBSECRET");
    expect(allValues).not.toContain("nsec1evil");
    const dump = buildSupportDump(item);
    expect(dump).not.toContain("cashuBSECRET");
    expect(dump).not.toContain("proofs");
    expect(dump).not.toContain("nsec1evil");
    expect(dump).toContain("ok-field");
  });

  it("dumps the row columns, request status and merged ids", () => {
    const requestRow = record({
      direction: "in",
      method: REQUEST_TRANSACTION_METHOD,
      status: "pending",
      happenedAtSec: 100,
      detailsJson: json({ [REQUEST_ID_DETAIL]: "req-9", [REQUEST_TEXT_DETAIL]: "hi" }),
    });
    const fulfillment = record({
      direction: "in",
      status: "completed",
      happenedAtSec: 200,
      detailsJson: json({ [REQUEST_ID_DETAIL]: "req-9" }),
    });
    const item = buildTransactionHistory([requestRow, fulfillment])[0]!;
    const dump = JSON.parse(buildSupportDump(item)) as Record<string, unknown>;
    expect(dump["id"]).toBe(requestRow.id);
    expect(dump["requestStatus"]).toBe("paid");
    expect(dump["mergedTransactionIds"]).toEqual([fulfillment.id]);
    expect((dump["details"] as Record<string, unknown>)[REQUEST_ID_DETAIL]).toBe("req-9");
  });
});

describe("parseTransactionDetails", () => {
  it("parses objects and rejects malformed/non-object payloads", () => {
    expect(parseTransactionDetails(json({ a: 1 }))).toEqual({ a: 1 });
    expect(parseTransactionDetails(null)).toBeNull();
    expect(parseTransactionDetails("not json")).toBeNull();
    expect(parseTransactionDetails('["array"]')).toBeNull();
    expect(parseTransactionDetails('"string"')).toBeNull();
  });
});
