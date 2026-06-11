/**
 * TransactionsRepository — wallet history on the `transactions` lane
 * (issue #35; `tx.*` feature map).
 *
 * One row per payment outcome (`tx.record`): successes, failures (error
 * kept — "error records are valuable for support"), and intermediate
 * phases. The shape follows the PoC's phase-rich `transaction` table; a
 * flow inserts a `pending` record up front and patches
 * status/phase/error/fee as it progresses, so an interrupted payment leaves
 * an honest record of how far it got.
 *
 * Secrecy contract (`tx.details`): `detailsJson`, `error`, and `note` must
 * never contain raw proofs, serialized tokens, or private keys — callers
 * serialize support-safe data only. This repository stores strings opaquely
 * and never logs them.
 *
 * History list (`tx.list`): newest first by domain time (`happenedAtSec`),
 * cursor paging exactly like #25's message paging ((happenedAtSec, id)
 * strictly-older cursor).
 */
import { createFormatTypeError } from "@evolu/common";

import { normalizeMintUrl } from "@linky/core";

import type { LinkyStore } from "../createLinkyStore";
import { ContactId, TransactionId } from "../schema";
import { repoErr, repoOk } from "./repository";
import type { RepoResult } from "./repository";

export type TransactionDirection = "in" | "out";

/** One history entry as core sees it. Plain data, no Evolu types. */
export interface TransactionRecord {
  readonly id: string;
  /** Unix seconds when the transaction happened (domain time). */
  readonly happenedAtSec: number;
  readonly direction: TransactionDirection;
  /** e.g. "pending" | "completed" | "failed". */
  readonly status: string;
  /** e.g. "cashu" | "lightning" | "internal". */
  readonly category: string;
  /** Payment method detail, e.g. "token" | "invoice" | "lnaddress". */
  readonly method: string | null;
  /** Last reached flow phase (free-form breadcrumb). */
  readonly phase: string | null;
  readonly amount: number | null;
  readonly feeAmount: number | null;
  readonly unit: string | null;
  /** Normalized mint URL when known. */
  readonly mintUrl: string | null;
  /** Counterparty contact id, when known. */
  readonly contactId: string | null;
  readonly note: string | null;
  /** Error message for failed/partial outcomes. */
  readonly error: string | null;
  /** Free-form JSON details payload (support-safe). */
  readonly detailsJson: string | null;
  /** ISO timestamp maintained by the storage layer. */
  readonly createdAt: string;
  /** ISO timestamp maintained by the storage layer; null until the first update. */
  readonly updatedAt: string | null;
}

export interface NewTransaction {
  readonly happenedAtSec: number;
  readonly direction: TransactionDirection;
  readonly status: string;
  readonly category: string;
  readonly method?: string;
  readonly phase?: string;
  readonly amount?: number;
  readonly feeAmount?: number;
  readonly unit?: string;
  readonly mintUrl?: string;
  readonly contactId?: string;
  readonly note?: string;
  readonly error?: string;
  readonly detailsJson?: string;
}

/** Fields patchable as a flow progresses; `null` clears, `undefined` leaves untouched. */
export interface TransactionPatch {
  readonly status?: string;
  readonly phase?: string | null;
  readonly method?: string | null;
  readonly amount?: number | null;
  readonly feeAmount?: number | null;
  readonly unit?: string | null;
  readonly mintUrl?: string | null;
  readonly contactId?: string | null;
  readonly note?: string | null;
  readonly error?: string | null;
  readonly detailsJson?: string | null;
}

/** Newest-first history page request (`tx.list`). */
export interface TransactionPageRequest {
  readonly limit: number;
  /** Continue after this cursor (from a previous page's `nextCursor`). */
  readonly cursor?: TransactionCursor;
}

/** Page cursor: position of the last item of the previous page. */
export interface TransactionCursor {
  readonly happenedAtSec: number;
  readonly id: string;
}

export interface TransactionPage {
  /** Newest first. */
  readonly items: ReadonlyArray<TransactionRecord>;
  /** Cursor for the next (older) page; null when this page was the last. */
  readonly nextCursor: TransactionCursor | null;
}

export interface TransactionValidationError {
  readonly _tag: "TransactionValidationError";
  readonly reason: string;
}

export interface InvalidTransactionIdError {
  readonly _tag: "InvalidTransactionIdError";
  readonly id: string;
}

export type TransactionsRepositoryError = TransactionValidationError | InvalidTransactionIdError;

export interface TransactionsRepository {
  /** Records a payment outcome / starts a phase-tracked entry; returns its id. */
  readonly record: (
    transaction: NewTransaction,
  ) => RepoResult<{ readonly id: string }, TransactionsRepositoryError>;
  /** Patches an entry as the flow progresses (status, phase, error, fees…). */
  readonly update: (
    id: string,
    patch: TransactionPatch,
  ) => RepoResult<{ readonly id: string }, TransactionsRepositoryError>;
  /** The entry with this id, or null. */
  readonly getById: (id: string) => Promise<TransactionRecord | null>;
  /** One history page, newest first, cursor-based (`tx.list`). */
  readonly listPage: (request: TransactionPageRequest) => Promise<TransactionPage>;
}

const formatTypeError = createFormatTypeError();

/** Casts a validated plain value to a branded query-builder value. */
const asParam = (value: string | number): never => value as never;

/** Strips `undefined` entries so "not provided" never overwrites a column. */
const definedEntries = <T extends Record<string, unknown>>(props: T): Partial<T> =>
  Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined)) as Partial<T>;

interface TransactionRowLike {
  readonly id: unknown;
  readonly happenedAtSec: unknown;
  readonly direction: unknown;
  readonly status: unknown;
  readonly category: unknown;
  readonly method: unknown;
  readonly phase: unknown;
  readonly amount: unknown;
  readonly feeAmount: unknown;
  readonly unit: unknown;
  readonly mint: unknown;
  readonly contactId: unknown;
  readonly note: unknown;
  readonly error: unknown;
  readonly detailsJson: unknown;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
}

const toNullableString = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

const toNullableNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

const toTransactionRecord = (row: TransactionRowLike): TransactionRecord => ({
  id: String(row.id),
  happenedAtSec: Number(row.happenedAtSec),
  direction: row.direction === "out" ? "out" : "in",
  status: String(row.status),
  category: String(row.category),
  method: toNullableString(row.method),
  phase: toNullableString(row.phase),
  amount: toNullableNumber(row.amount),
  feeAmount: toNullableNumber(row.feeAmount),
  unit: toNullableString(row.unit),
  mintUrl: toNullableString(row.mint),
  contactId: toNullableString(row.contactId),
  note: toNullableString(row.note),
  error: toNullableString(row.error),
  detailsJson: toNullableString(row.detailsJson),
  createdAt: String(row.createdAt),
  updatedAt: row.updatedAt === null ? null : String(row.updatedAt),
});

/** Normalizes the mint URL when present; null/undefined pass through. */
const normalizedMintColumn = (mintUrl: string | null | undefined): string | null | undefined => {
  if (mintUrl === undefined || mintUrl === null) return mintUrl;
  const normalized = normalizeMintUrl(mintUrl);
  return normalized === "" ? null : normalized;
};

export const createTransactionsRepository = (store: LinkyStore): TransactionsRepository => {
  const parseContactId = (
    contactId: string,
  ): RepoResult<ContactId, TransactionValidationError> => {
    const parsed = ContactId.fromUnknown(contactId);
    return parsed.ok
      ? repoOk(parsed.value)
      : repoErr({
          _tag: "TransactionValidationError" as const,
          reason: `invalid contactId: ${contactId}`,
        });
  };

  return {
    record: (transaction) => {
      let contactId: ContactId | undefined;
      if (transaction.contactId !== undefined) {
        const parsed = parseContactId(transaction.contactId);
        if (!parsed.ok) return parsed;
        contactId = parsed.value;
      }
      const mint = normalizedMintColumn(transaction.mintUrl);
      const result = store.insert("transaction", {
        happenedAtSec: transaction.happenedAtSec,
        direction: transaction.direction,
        status: transaction.status,
        category: transaction.category,
        ...definedEntries({
          method: transaction.method,
          phase: transaction.phase,
          amount: transaction.amount,
          feeAmount: transaction.feeAmount,
          unit: transaction.unit,
          note: transaction.note,
          error: transaction.error,
          detailsJson: transaction.detailsJson,
        }),
        ...(mint === undefined ? {} : { mint }),
        ...(contactId === undefined ? {} : { contactId }),
      });
      if (!result.ok) {
        return repoErr({
          _tag: "TransactionValidationError" as const,
          reason: formatTypeError(result.error as never),
        });
      }
      return repoOk({ id: String(result.value.id) });
    },

    update: (id, patch) => {
      const parsedId = TransactionId.fromUnknown(id);
      if (!parsedId.ok) return repoErr({ _tag: "InvalidTransactionIdError" as const, id });
      let contactId: ContactId | null | undefined = undefined;
      if (patch.contactId !== undefined) {
        if (patch.contactId === null) contactId = null;
        else {
          const parsed = parseContactId(patch.contactId);
          if (!parsed.ok) return parsed;
          contactId = parsed.value;
        }
      }
      const mint = normalizedMintColumn(patch.mintUrl);
      const result = store.update("transaction", {
        id: parsedId.value,
        ...definedEntries({
          status: patch.status,
          phase: patch.phase,
          method: patch.method,
          amount: patch.amount,
          feeAmount: patch.feeAmount,
          unit: patch.unit,
          note: patch.note,
          error: patch.error,
          detailsJson: patch.detailsJson,
        }),
        ...(mint === undefined ? {} : { mint }),
        ...(contactId === undefined ? {} : { contactId }),
      });
      if (!result.ok) {
        return repoErr({
          _tag: "TransactionValidationError" as const,
          reason: formatTypeError(result.error as never),
        });
      }
      return repoOk({ id: String(result.value.id) });
    },

    getById: async (id) => {
      const query = store.evolu.createQuery((db) =>
        db
          .selectFrom("transaction")
          .selectAll()
          .where("isDeleted", "is not", 1)
          .where("id", "=", asParam(id))
          .limit(1),
      );
      const rows = await store.evolu.loadQuery(query);
      const row = rows[0];
      return row === undefined ? null : toTransactionRecord(row);
    },

    listPage: async ({ limit, cursor }) => {
      const query = store.evolu.createQuery((db) => {
        let q = db.selectFrom("transaction").selectAll().where("isDeleted", "is not", 1);
        if (cursor !== undefined) {
          // Strictly older than the cursor position: (happenedAtSec, id) <
          // (cursor.happenedAtSec, cursor.id) in the newest-first ordering.
          q = q.where((eb) =>
            eb.or([
              eb("happenedAtSec", "<", asParam(cursor.happenedAtSec)),
              eb.and([
                eb("happenedAtSec", "=", asParam(cursor.happenedAtSec)),
                eb("id", "<", asParam(cursor.id)),
              ]),
            ]),
          );
        }
        return q.orderBy("happenedAtSec", "desc").orderBy("id", "desc").limit(limit);
      });
      const rows = await store.evolu.loadQuery(query);
      const items = rows.map(toTransactionRecord);
      const last = items.at(-1);
      const nextCursor =
        items.length === limit && last !== undefined
          ? { happenedAtSec: last.happenedAtSec, id: last.id }
          : null;
      return { items, nextCursor };
    },
  };
};
