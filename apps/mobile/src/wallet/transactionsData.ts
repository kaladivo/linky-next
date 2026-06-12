/**
 * Transactions data seam (#43) — the impure half over
 * ./transactionsModel.ts, following the walletData conventions: Effect
 * loaders over the session store (`getReadyLinkyStore`), re-queried by
 * screens via the store data version.
 *
 * History reads the newest `HISTORY_FETCH_CAP` rows (cursor-paged under
 * the hood) and joins contacts (`tx.link-contact`) and known mints
 * (`tx.link-mint`) for display/link resolution. The cap exists only to
 * bound a pathological local history; the merge logic (issued-spend,
 * request fulfillment) runs within the fetched window — merge partners are
 * written moments apart, so a 500-row window cannot realistically split a
 * pair.
 *
 * Request-status data dependency (#45, `tx.request-status`): the DECLINE
 * signal lives in chat, not in transaction rows — declining a request is a
 * `linky:req-decline:v1:<requestRumorId>` chat message. Each history build
 * scans the (rare) request/decline messages by content prefix
 * (`loadMessagesByContentPrefix`), maps decline → request rumor → NUT-18
 * `requestId` (chatPaymentsModel.declinedRequestIds, the PoC's
 * TransactionsPage derivation), and feeds the set into the model; a
 * completed fulfillment row still wins over a decline (paid > declined,
 * PoC parity).
 */
import {
  PAYMENT_REQUEST_DECLINE_PREFIX,
  PAYMENT_REQUEST_PREFIX,
} from "@linky/core";
import type { ContactRecord, MintRecord, TransactionRecord } from "@linky/evolu-store";
import {
  createContactsRepository,
  createMintsRepository,
  createTransactionsRepository,
  loadMessagesByContentPrefix,
} from "@linky/evolu-store";
import type { LinkyStore } from "@linky/evolu-store";
import { Effect } from "effect";

import { declinedRequestIds } from "../chat/chatPaymentsModel";
import { getReadyLinkyStore } from "../store/storeManager";
import { buildTransactionHistory } from "./transactionsModel";
import type { HistoryItem } from "./transactionsModel";

/** Upper bound on history rows loaded for the list/merge (newest first). */
export const HISTORY_FETCH_CAP = 500;
const PAGE_LIMIT = 200;

/** Request ids declined via chat (#45 — see module doc). */
const loadDeclinedRequestIds = async (store: LinkyStore): Promise<ReadonlySet<string>> => {
  const messages = await loadMessagesByContentPrefix(store, [
    PAYMENT_REQUEST_PREFIX,
    `${PAYMENT_REQUEST_DECLINE_PREFIX}:`,
  ]);
  return declinedRequestIds(
    messages.filter((message) => message.content.startsWith(PAYMENT_REQUEST_PREFIX)),
    messages.filter((message) => message.content.startsWith(PAYMENT_REQUEST_DECLINE_PREFIX)),
  );
};

export interface TransactionHistoryView {
  /** Rendered history items, newest first (merged per the model). */
  readonly items: ReadonlyArray<HistoryItem>;
  readonly contactsById: ReadonlyMap<string, ContactRecord>;
  /** Known mints by normalized URL — mint links render only for these. */
  readonly mintsByUrl: ReadonlyMap<string, MintRecord>;
  /** True when more rows exist beyond `HISTORY_FETCH_CAP`. */
  readonly truncated: boolean;
}

const fetchNewestRecords = async (
  transactions: ReturnType<typeof createTransactionsRepository>,
): Promise<{ records: ReadonlyArray<TransactionRecord>; truncated: boolean }> => {
  const records: TransactionRecord[] = [];
  let cursor: { happenedAtSec: number; id: string } | undefined;
  for (;;) {
    const page = await transactions.listPage({
      limit: PAGE_LIMIT,
      ...(cursor === undefined ? {} : { cursor }),
    });
    records.push(...page.items);
    if (page.nextCursor === null) return { records, truncated: false };
    if (records.length >= HISTORY_FETCH_CAP) return { records, truncated: true };
    cursor = page.nextCursor;
  }
};

const loadHistoryView = async (): Promise<TransactionHistoryView> => {
  const store = await getReadyLinkyStore();
  const [{ records, truncated }, contacts, mints, declined] = await Promise.all([
    fetchNewestRecords(createTransactionsRepository(store)),
    createContactsRepository(store).list(),
    createMintsRepository(store).list(),
    loadDeclinedRequestIds(store),
  ]);
  return {
    items: buildTransactionHistory(records, declined),
    contactsById: new Map(contacts.map((contact) => [contact.id, contact])),
    mintsByUrl: new Map(mints.map((mint) => [mint.url, mint])),
    truncated,
  };
};

/** The history list (`tx.list`) with contact/mint join. */
export const loadTransactionHistory: Effect.Effect<TransactionHistoryView> =
  Effect.promise(loadHistoryView);

export interface TransactionDetailView {
  readonly item: HistoryItem;
  /** Counterparty contact when linked and still present (`tx.link-contact`). */
  readonly contact: ContactRecord | null;
  /** The known-mint row for the entry's mint, when any (`tx.link-mint`). */
  readonly mint: MintRecord | null;
}

/**
 * The detail view for one history entry. Resolved through the full history
 * build so a merged entry shows its combined details; ids of merged-away
 * rows resolve to their absorbing item. Falls back to a direct row read so
 * stale links (row beyond the cap) still open.
 */
export const loadTransactionDetail = (id: string): Effect.Effect<TransactionDetailView | null> =>
  Effect.promise(async () => {
    const view = await loadHistoryView();
    let item =
      view.items.find((entry) => entry.record.id === id) ??
      view.items.find((entry) => entry.mergedIds.includes(id)) ??
      null;
    if (item === null) {
      const store = await getReadyLinkyStore();
      const record = await createTransactionsRepository(store).getById(id);
      if (record === null) return null;
      item = buildTransactionHistory([record], await loadDeclinedRequestIds(store))[0] ?? null;
      if (item === null) return null;
    }
    const contact =
      item.record.contactId === null
        ? null
        : (view.contactsById.get(item.record.contactId) ?? null);
    const mint =
      item.record.mintUrl === null ? null : (view.mintsByUrl.get(item.record.mintUrl) ?? null);
    return { item, contact, mint };
  });

/** The counterparty display label: name > lightning address > npub. */
export const contactDisplayLabel = (contact: ContactRecord | null): string | null => {
  if (contact === null) return null;
  return contact.name ?? contact.lnAddress ?? contact.npub;
};
