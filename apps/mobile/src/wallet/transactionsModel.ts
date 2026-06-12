/**
 * Transaction history presentation model (#43; `tx.list` / `tx.details` /
 * `tx.request-status` / `tx.merge-issued-token-spend`) — the PURE half of
 * the transactions screens. No React, no storage; the data seam lives in
 * ./transactionsData.ts.
 *
 * ## What a history item is
 *
 * One `transaction` row (#35 TransactionsRepository) becomes one history
 * item, EXCEPT where the PoC's TransactionsPage merges rows:
 *
 * - **Issued-then-spent merge** (`tx.merge-issued-token-spend`): when a
 *   token the wallet emitted is later consumed by a successful spend, the
 *   emit row is hidden and its details fold into the spend row — emit-and-
 *   send reads as ONE history item. The PoC keyed this merge on the raw
 *   serialized token strings (`details.issuedToken` / `usedInputTokens`);
 *   the rewrite's `detailsJson` must never carry tokens (secrecy contract),
 *   so the merge keys on the `cashuToken` ROW IDS instead:
 *
 *     - emit rows carry  `detailsJson.issuedTokenId: string`
 *     - spend rows carry `detailsJson.usedTokenIds: string[]`
 *
 *   Issue #44 (chat token send) plugs in by writing those two fields.
 *
 * - **Request fulfillment merge** (`tx.request-status`): a payment-request
 *   row (direction "in", method `REQUEST_TRANSACTION_METHOD`, details carry
 *   `requestId` + `requestText`) absorbs its successful fulfillment row
 *   (any completed non-request row with the same `requestId`), and shows a
 *   pending / paid / declined status. Request + fulfillment rows are
 *   written by #45 (not yet implemented); "declined" additionally needs the
 *   chat decline messages #45 parses — until then callers pass an empty
 *   `declinedRequestIds` set and no row renders as declined.
 *
 * **Error records are never merged away** (feature-map contract: "error
 * records are valuable for support"): only `completed` rows participate in
 * either merge, so failed emits, failed spends and failed fulfillment
 * attempts always keep their own visible row. (PoC divergence — the PoC
 * hid ANY row sharing a fulfilled request's `requestId`, including failed
 * attempts.)
 *
 * ## User-facing vs support-only fields (`tx.details`, pending #59)
 *
 * Decision ticket #59 (open) will finalize the split; until then this
 * module implements the following documented split (see also
 * docs/feature-map/transactions.md):
 *
 * - **User-facing**: amount, fee, date, direction, status, counterparty
 *   contact, mint display name, note, error message, payment-request text,
 *   LNURL success message/URL, lightning memo, lightning address.
 * - **Support-only** (collapsed behind "Support details", all copyable):
 *   transaction id, category/method, phase breadcrumb, full mint URL,
 *   source mint (consolidations), BOLT11 invoice, payment preimage, quote
 *   id, request id, issued/used token ROW references.
 * - **Never surfaced anywhere**: serialized tokens, raw proofs, private
 *   keys — they are never written to `detailsJson` in the first place
 *   (TransactionsRepository contract), and this module additionally
 *   whitelists every detail key it emits, so an upstream contract bug can
 *   not leak through the UI or the support dump.
 */
import type { TranslationKey } from "@linky/locales";
import type { TransactionRecord } from "@linky/evolu-store";

// ---------------------------------------------------------------------------
// Row contracts shared with the writing flows (#44 / #45 plug in here)
// ---------------------------------------------------------------------------

/** `transaction.method` of a chat payment-request row (#45). */
export const REQUEST_TRANSACTION_METHOD = "chat-request";

/** `detailsJson` key carrying the emitted token's `cashuToken` row id (#44 emit rows). */
export const ISSUED_TOKEN_ID_DETAIL = "issuedTokenId";
/** `detailsJson` key carrying consumed tokens' `cashuToken` row ids (#44 spend rows). */
export const USED_TOKEN_IDS_DETAIL = "usedTokenIds";
/** `detailsJson` key carrying the payment-request id (#45 request + fulfillment rows). */
export const REQUEST_ID_DETAIL = "requestId";
/** `detailsJson` key carrying the human request message (#45 request rows). */
export const REQUEST_TEXT_DETAIL = "requestText";

/** The three row statuses the rewrite's flows write. */
export const TX_STATUS_PENDING = "pending";
export const TX_STATUS_COMPLETED = "completed";
export const TX_STATUS_FAILED = "failed";

/** `transaction.phase` of a spend row whose intent sits in the #46 queue. */
export const QUEUED_TRANSACTION_PHASE = "queued";
/**
 * `transaction.error` of a queued contact payment that expired before the
 * device came back online (#46, `chat-pay.queue`): the row reads as failed
 * but the list shows the dedicated "expired" pill — funds were never
 * minted, so nothing was lost.
 */
export const TX_ERROR_QUEUE_EXPIRED = "queued payment expired";

// ---------------------------------------------------------------------------
// detailsJson parsing (whitelist-based)
// ---------------------------------------------------------------------------

export type DetailsRecord = Readonly<Record<string, unknown>>;

/** Parses a `detailsJson` payload to a plain object; null for anything else. */
export const parseTransactionDetails = (raw: string | null): DetailsRecord | null => {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as DetailsRecord;
  } catch {
    return null;
  }
};

const readString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

const readStringArray = (value: unknown): ReadonlyArray<string> => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => readString(entry))
    .filter((entry): entry is string => entry !== null);
};

const detailString = (details: DetailsRecord | null, key: string): string | null =>
  details === null ? null : readString(details[key]);

const detailStringArray = (details: DetailsRecord | null, key: string): ReadonlyArray<string> =>
  details === null ? [] : readStringArray(details[key]);

// ---------------------------------------------------------------------------
// History build (merge + request status)
// ---------------------------------------------------------------------------

export type RequestStatus = "pending" | "paid" | "declined";

/** One rendered history entry — a primary row plus rows merged into it. */
export interface HistoryItem {
  readonly record: TransactionRecord;
  /** Parsed + merge-combined details (merge partner's fields win, PoC parity). */
  readonly details: DetailsRecord | null;
  /** Ids of rows hidden by this item (emit half, request fulfillment). */
  readonly mergedIds: ReadonlyArray<string>;
  /** Pending / paid / declined for payment-request rows; null otherwise. */
  readonly requestStatus: RequestStatus | null;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

const isRequestRow = (record: TransactionRecord, details: DetailsRecord | null): boolean =>
  record.direction === "in" &&
  record.method === REQUEST_TRANSACTION_METHOD &&
  detailString(details, REQUEST_ID_DETAIL) !== null &&
  detailString(details, REQUEST_TEXT_DETAIL) !== null;

/** `{...primary, ...secondary}` — the secondary (merge partner) wins, PoC parity. */
const mergeDetails = (
  primary: DetailsRecord | null,
  secondary: DetailsRecord | null,
): DetailsRecord | null => {
  if (primary === null && secondary === null) return null;
  return { ...(primary ?? {}), ...(secondary ?? {}) };
};

/**
 * Builds the rendered history (newest first) from repository rows:
 * issued-spend merge, request-fulfillment merge, request status.
 *
 * `declinedRequestIds` is the #45 seam: request ids the chat layer saw a
 * decline message for. Pass `undefined` (empty) until #45 lands.
 */
export const buildTransactionHistory = (
  records: ReadonlyArray<TransactionRecord>,
  declinedRequestIds: ReadonlySet<string> = EMPTY_SET,
): ReadonlyArray<HistoryItem> => {
  const sorted = [...records].sort((a, b) => {
    if (a.happenedAtSec !== b.happenedAtSec) return b.happenedAtSec - a.happenedAtSec;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  const detailsById = new Map<string, DetailsRecord | null>(
    sorted.map((record) => [record.id, parseTransactionDetails(record.detailsJson)]),
  );
  const completed = (record: TransactionRecord): boolean => record.status === TX_STATUS_COMPLETED;

  // Newest-first "first wins" maps, exactly like the PoC's pass over the
  // sorted list. Only COMPLETED rows enter the merge maps — that is what
  // keeps every error/pending record visible.
  const requestRowByRequestId = new Map<string, TransactionRecord>();
  const fulfillmentByRequestId = new Map<string, TransactionRecord>();
  const emitRowByTokenId = new Map<string, TransactionRecord>();
  const spendRowByTokenId = new Map<string, TransactionRecord>();

  for (const record of sorted) {
    const details = detailsById.get(record.id) ?? null;
    const requestId = detailString(details, REQUEST_ID_DETAIL);
    if (requestId !== null) {
      if (isRequestRow(record, details)) {
        if (!requestRowByRequestId.has(requestId)) requestRowByRequestId.set(requestId, record);
      } else if (completed(record) && !fulfillmentByRequestId.has(requestId)) {
        fulfillmentByRequestId.set(requestId, record);
      }
    }
    if (!completed(record)) continue;
    const issuedTokenId = detailString(details, ISSUED_TOKEN_ID_DETAIL);
    if (issuedTokenId !== null && !emitRowByTokenId.has(issuedTokenId)) {
      emitRowByTokenId.set(issuedTokenId, record);
    }
    for (const tokenId of detailStringArray(details, USED_TOKEN_IDS_DETAIL)) {
      if (!spendRowByTokenId.has(tokenId)) spendRowByTokenId.set(tokenId, record);
    }
  }

  const items: HistoryItem[] = [];
  for (const record of sorted) {
    const ownDetails = detailsById.get(record.id) ?? null;
    const requestId = detailString(ownDetails, REQUEST_ID_DETAIL);
    const isRequest = isRequestRow(record, ownDetails);

    // Hidden: a completed fulfillment absorbed by its request row.
    if (
      !isRequest &&
      completed(record) &&
      requestId !== null &&
      requestRowByRequestId.has(requestId)
    ) {
      continue;
    }

    // Hidden: a completed emit row whose token a DIFFERENT completed row spent.
    const issuedTokenId = detailString(ownDetails, ISSUED_TOKEN_ID_DETAIL);
    if (issuedTokenId !== null && completed(record)) {
      const spender = spendRowByTokenId.get(issuedTokenId);
      if (spender !== undefined && spender.id !== record.id) continue;
    }

    let details = ownDetails;
    const mergedIds: string[] = [];

    // Spend row: fold the emit half in (`tx.merge-issued-token-spend`).
    if (completed(record)) {
      for (const tokenId of detailStringArray(ownDetails, USED_TOKEN_IDS_DETAIL)) {
        const emitRow = emitRowByTokenId.get(tokenId);
        if (emitRow === undefined || emitRow.id === record.id) continue;
        details = mergeDetails(details, detailsById.get(emitRow.id) ?? null);
        mergedIds.push(emitRow.id);
        break;
      }
    }

    // Request row: fold the fulfillment in and derive the status.
    let requestStatus: RequestStatus | null = null;
    if (isRequest && requestId !== null) {
      const fulfillment = fulfillmentByRequestId.get(requestId);
      if (fulfillment !== undefined) {
        details = mergeDetails(details, detailsById.get(fulfillment.id) ?? null);
        mergedIds.push(fulfillment.id);
        requestStatus = "paid";
      } else {
        requestStatus = declinedRequestIds.has(requestId) ? "declined" : "pending";
      }
    }

    items.push({ record, details, mergedIds, requestStatus });
  }
  return items;
};

// ---------------------------------------------------------------------------
// Titles (PoC buildTitle, adapted to the rewrite's method/category names)
// ---------------------------------------------------------------------------

export type TransactionTitleKey = Extract<
  TranslationKey,
  | "requestPaymentLabel"
  | "transactionReceivedFromContact"
  | "transactionSentToContact"
  | "transactionTopupInvoice"
  | "transactionTopupLnAddress"
  | "transactionPaidLightningInvoice"
  | "transactionPaidLightningAddress"
  | "transactionCashuInserted"
  | "transactionCashuRestored"
  | "transactionCashuIssued"
  | "transactionCashuSwap"
>;

export type TransactionTitle =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "key"; readonly key: TransactionTitleKey };

/**
 * The list/detail title: request label > note > contact label > flow label.
 * `contactLabel` is the resolved counterparty display string (or null).
 */
export const transactionTitle = (
  item: HistoryItem,
  contactLabel: string | null,
): TransactionTitle => {
  if (item.requestStatus !== null) return { kind: "key", key: "requestPaymentLabel" };
  const note = item.record.note;
  if (note !== null && note.trim() !== "") return { kind: "text", text: note };
  if (contactLabel !== null && contactLabel.trim() !== "") {
    return { kind: "text", text: contactLabel };
  }
  const { category, method, direction } = item.record;
  if (category === "lightning") {
    if (direction === "in") {
      return {
        kind: "key",
        key: method === "lnaddress" ? "transactionTopupLnAddress" : "transactionTopupInvoice",
      };
    }
    return {
      kind: "key",
      key:
        method === "lnaddress"
          ? "transactionPaidLightningAddress"
          : "transactionPaidLightningInvoice",
    };
  }
  if (category === "contacts") {
    return {
      kind: "key",
      key: direction === "in" ? "transactionReceivedFromContact" : "transactionSentToContact",
    };
  }
  if (method === "swap") return { kind: "key", key: "transactionCashuSwap" };
  if (method === "receive") return { kind: "key", key: "transactionCashuInserted" };
  if (method === "restore") return { kind: "key", key: "transactionCashuRestored" };
  return {
    kind: "key",
    key: direction === "in" ? "transactionCashuInserted" : "transactionCashuIssued",
  };
};

/** PoC date format: full date + time, locale-aware. */
export const formatTransactionDate = (locale: string, happenedAtSec: number): string =>
  new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(happenedAtSec * 1000));

// ---------------------------------------------------------------------------
// Status pill (`tx.request-status` + pending/failed states)
// ---------------------------------------------------------------------------

export type TransactionPillTone = "ok" | "muted" | "danger";

export interface TransactionStatusPill {
  readonly tone: TransactionPillTone;
  readonly labelKey: Extract<
    TranslationKey,
    | "transactionPending"
    | "transactionFailed"
    | "transactionExpired"
    | "paymentRequestStatusPaid"
    | "paymentRequestStatusDeclined"
  >;
}

/**
 * The list-row status pill. For request rows the DERIVED request status
 * governs (a fulfilled request shows "paid" even while the request row's
 * own status column is still "pending"); other rows show pending/failed,
 * and completed rows show no pill (PoC parity).
 */
export const transactionStatusPill = (item: HistoryItem): TransactionStatusPill | null => {
  if (item.requestStatus !== null) {
    switch (item.requestStatus) {
      case "pending":
        return { tone: "muted", labelKey: "transactionPending" };
      case "paid":
        return { tone: "ok", labelKey: "paymentRequestStatusPaid" };
      case "declined":
        return { tone: "danger", labelKey: "paymentRequestStatusDeclined" };
    }
  }
  if (item.record.status === TX_STATUS_PENDING) {
    return { tone: "muted", labelKey: "transactionPending" };
  }
  if (item.record.status === TX_STATUS_FAILED) {
    // Expired queue intents (#46): visibly distinct from real failures —
    // nothing was minted, the funds never left the wallet.
    if (item.record.error === TX_ERROR_QUEUE_EXPIRED) {
      return { tone: "muted", labelKey: "transactionExpired" };
    }
    return { tone: "danger", labelKey: "transactionFailed" };
  }
  return null;
};

/** Detail-header status label key; null = render the raw status string. */
export const transactionStatusLabelKey = (
  status: string,
): Extract<
  TranslationKey,
  "transactionPending" | "transactionCompleted" | "transactionFailed"
> | null => {
  switch (status) {
    case TX_STATUS_PENDING:
      return "transactionPending";
    case TX_STATUS_COMPLETED:
      return "transactionCompleted";
    case TX_STATUS_FAILED:
      return "transactionFailed";
    default:
      return null;
  }
};

// ---------------------------------------------------------------------------
// Detail fields (`tx.details`) — user-facing vs support-only split (#59 pending)
// ---------------------------------------------------------------------------

export type TransactionDetailLabelKey = Extract<
  TranslationKey,
  | "transactionDetailError"
  | "transactionDetailRequestText"
  | "transactionDetailLnurlSuccessMessage"
  | "transactionDetailLnurlSuccessUrl"
  | "transactionDetailLightningMemo"
  | "transactionDetailLightningAddress"
  | "transactionDetailId"
  | "transactionDetailMethod"
  | "transactionDetailPhase"
  | "transactionDetailMint"
  | "transactionDetailSourceMint"
  | "transactionDetailLightningInvoice"
  | "transactionDetailLightningPreimage"
  | "transactionDetailQuoteId"
  | "transactionDetailRequestId"
  | "transactionDetailIssuedTokenRef"
  | "transactionDetailUsedTokenRefs"
>;

export interface TransactionDetailField {
  readonly labelKey: TransactionDetailLabelKey;
  /** Display value (long values pre-compacted). */
  readonly value: string;
  /** Full value for the copy action; the display value copies otherwise. */
  readonly copyValue?: string;
}

export interface TransactionDetailSections {
  readonly user: ReadonlyArray<TransactionDetailField>;
  readonly support: ReadonlyArray<TransactionDetailField>;
}

/** PoC's long-string compaction (invoices, preimages). */
export const formatCompactValue = (value: string): string =>
  value.length <= 20 ? value : `${value.slice(0, 8)}...${value.slice(-6)}`;

const field = (
  labelKey: TransactionDetailLabelKey,
  value: string | null,
  options: { readonly compact?: boolean } = {},
): TransactionDetailField | null => {
  if (value === null) return null;
  if (options.compact === true && value.length > 20) {
    return { labelKey, value: formatCompactValue(value), copyValue: value };
  }
  return { labelKey, value };
};

const present = (
  fields: ReadonlyArray<TransactionDetailField | null>,
): ReadonlyArray<TransactionDetailField> =>
  fields.filter((entry): entry is TransactionDetailField => entry !== null);

/**
 * The detail screen's field lists, split per the documented #59-pending
 * decision (module doc). Every detail key is explicitly whitelisted —
 * unknown `detailsJson` keys never reach the UI.
 */
export const transactionDetailSections = (item: HistoryItem): TransactionDetailSections => {
  const { record, details } = item;
  const usedTokenIds = detailStringArray(details, USED_TOKEN_IDS_DETAIL);
  // Top-up/consolidation rows store the BOLT11 under `invoice` (quote
  // payload), pay rows under `lightningInvoice` — surface either.
  const invoice =
    detailString(details, "lightningInvoice") ?? detailString(details, "invoice");

  return {
    user: present([
      field("transactionDetailError", record.error),
      field("transactionDetailRequestText", detailString(details, REQUEST_TEXT_DETAIL)),
      field("transactionDetailLnurlSuccessMessage", detailString(details, "lnurlSuccessMessage")),
      field("transactionDetailLnurlSuccessUrl", detailString(details, "lnurlSuccessUrl")),
      field("transactionDetailLightningMemo", detailString(details, "lightningMemo")),
      field("transactionDetailLightningAddress", detailString(details, "lightningAddress")),
    ]),
    support: present([
      field("transactionDetailId", record.id),
      field("transactionDetailMethod", `${record.category} / ${record.method ?? "—"}`),
      field("transactionDetailPhase", record.phase),
      field("transactionDetailMint", record.mintUrl),
      field("transactionDetailSourceMint", detailString(details, "sourceMintUrl")),
      field("transactionDetailLightningInvoice", invoice, { compact: true }),
      field("transactionDetailLightningPreimage", detailString(details, "lightningPreimage"), {
        compact: true,
      }),
      field("transactionDetailQuoteId", detailString(details, "quoteId")),
      field("transactionDetailRequestId", detailString(details, REQUEST_ID_DETAIL)),
      field("transactionDetailIssuedTokenRef", detailString(details, ISSUED_TOKEN_ID_DETAIL)),
      field(
        "transactionDetailUsedTokenRefs",
        usedTokenIds.length === 0 ? null : usedTokenIds.join(", "),
      ),
    ]),
  };
};

// ---------------------------------------------------------------------------
// Support dump ("copy support details")
// ---------------------------------------------------------------------------

/**
 * Detail keys allowed into the support dump — the same whitelist the
 * sections use, plus quote-payload metadata. Anything outside this list is
 * dropped, so even a (contract-violating) secret in `detailsJson` could
 * never leave the device via the copy button.
 */
const SUPPORT_DUMP_DETAIL_KEYS: ReadonlyArray<string> = [
  "lightningInvoice",
  "lightningMemo",
  "lightningAddress",
  "lightningPreimage",
  "lnurlSuccessMessage",
  "lnurlSuccessUrl",
  "invoice",
  "quoteId",
  "mintUrl",
  "unit",
  "amountSat",
  "expiresAtSec",
  "createdAtMs",
  "sourceMintUrl",
  REQUEST_ID_DETAIL,
  REQUEST_TEXT_DETAIL,
  ISSUED_TOKEN_ID_DETAIL,
  USED_TOKEN_IDS_DETAIL,
];

/** The copyable support payload: row columns + whitelisted details, as JSON. */
export const buildSupportDump = (item: HistoryItem): string => {
  const { record, details } = item;
  const safeDetails: Record<string, unknown> = {};
  if (details !== null) {
    for (const key of SUPPORT_DUMP_DETAIL_KEYS) {
      if (key in details && details[key] !== undefined) safeDetails[key] = details[key];
    }
  }
  return JSON.stringify(
    {
      id: record.id,
      happenedAtSec: record.happenedAtSec,
      direction: record.direction,
      status: record.status,
      category: record.category,
      method: record.method,
      phase: record.phase,
      amount: record.amount,
      feeAmount: record.feeAmount,
      unit: record.unit,
      mintUrl: record.mintUrl,
      contactId: record.contactId,
      note: record.note,
      error: record.error,
      requestStatus: item.requestStatus,
      mergedTransactionIds: item.mergedIds,
      details: safeDetails,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    },
    null,
    2,
  );
};
