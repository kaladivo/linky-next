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
 * Request-status data dependency (#45): the decline signal comes from chat
 * messages that #45 will parse; until it lands `DECLINED_REQUEST_IDS` stays
 * empty, so request rows only ever render pending/paid (the declined path
 * is built and unit-tested).
 */
import type { ContactRecord, MintRecord, TransactionRecord } from "@linky/evolu-store";
import {
  createContactsRepository,
  createMintsRepository,
  createTransactionsRepository,
} from "@linky/evolu-store";
import { Effect } from "effect";

import { getReadyLinkyStore } from "../store/storeManager";
import { buildTransactionHistory } from "./transactionsModel";
import type { HistoryItem } from "./transactionsModel";

/** Upper bound on history rows loaded for the list/merge (newest first). */
export const HISTORY_FETCH_CAP = 500;
const PAGE_LIMIT = 200;

/** #45 seam: request ids declined via chat. Empty until #45 lands. */
const DECLINED_REQUEST_IDS: ReadonlySet<string> = new Set();

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
  const [{ records, truncated }, contacts, mints] = await Promise.all([
    fetchNewestRecords(createTransactionsRepository(store)),
    createContactsRepository(store).list(),
    createMintsRepository(store).list(),
  ]);
  return {
    items: buildTransactionHistory(records, DECLINED_REQUEST_IDS),
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
      item = buildTransactionHistory([record], DECLINED_REQUEST_IDS)[0] ?? null;
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
