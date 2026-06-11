/**
 * TokensRepository — Cashu token persistence on the `wallet` lane
 * (issue #35; state model + record shape from #33, engine from #32).
 *
 * The repository persists `@linky/core` `TokenRecord`s in the `cashuToken`
 * table and is the enforcement boundary for the #33 state machine: every
 * state change goes through core's `transitionTokenRecord` /
 * `reconcileTokenRecords`, so an illegal (state, event) pair is rejected
 * HERE (typed error, nothing persisted) and can never reach storage. The
 * `state` column itself is constrained to the 8-state union at the schema
 * level (`CashuTokenState`), so even a raw mutation cannot write an
 * out-of-model state.
 *
 * Secrecy: the `token` column is bearer material. It lives in the
 * per-lane-encrypted wallet table (like the PoC) and this module never logs
 * it nor copies it into error values.
 *
 * Timestamps: `TokenRecord.createdAtMillis`/`updatedAtMillis` map to Evolu's
 * system `createdAt`/`updatedAt` columns (ISO strings, parsed to millis on
 * read). Transition functions receive the caller's `atMillis` (Effect
 * `Clock` at the call site) for their pure bookkeeping, but the persisted
 * audit time is storage-owned — close enough for the #33 purge window,
 * which is measured in hours/days, and one less column to keep in sync.
 *
 * Purging (`cashu.cleanup-spent`): synced Evolu rows cannot be physically
 * deleted, so "purge" = Evolu soft delete (`isDeleted`). The tombstone
 * syncs, every query here excludes tombstoned rows, and the bearer token
 * string of a purged row is dead value anyway (`spent`/`deleted` states
 * only).
 */
import { Either, Option } from "effect";

import {
  computeWalletBalances,
  isPurgeableTokenRecord,
  normalizeMintUrl,
  normalizeTokenState,
  recoverTokenRecord,
  reconcileTokenRecords,
  transitionTokenRecord,
} from "@linky/core";
import type {
  ProofGroupPartition,
  PurgePolicy,
  ReceiveTokenResult,
  TokenRecord,
  TokenState,
  TokenStateTransition,
  WalletBalances,
} from "@linky/core";
import { createFormatTypeError } from "@evolu/common";

import type { LinkyStore } from "../createLinkyStore";
import { CashuTokenId } from "../schema";
import { repoErr, repoOk } from "./repository";
import type { RepoResult } from "./repository";

/** Max length of the `error` column (`NonEmptyString1000`). */
const ERROR_MAX_LENGTH = 1000;

/** New token row; the storage assigns the id. */
export interface NewCashuToken {
  /** Mint URL; normalized (core `normalizeMintUrl`) before persisting. */
  readonly mintUrl: string;
  /** Currency unit; defaults to "sat". */
  readonly unit?: string;
  /** Sum of the token's proof amounts in `unit`; positive integer. */
  readonly amount: number;
  /** Initial #33 state (constructors produce "accepted" or "issued"). */
  readonly state: TokenState;
  /** Serialized Cashu token. Bearer secret — never logged. */
  readonly token: string;
  /** Error message (state "error" rows, e.g. PoC migration). */
  readonly error?: string;
}

/**
 * Transitions applicable via {@link TokensRepository.transition}. `Recover`
 * is excluded on purpose: a recovery replaces the stored token/amount with
 * the re-accepted result (the old proofs were consumed by the recovery
 * swap), so it has its own method — flipping `error → accepted` without the
 * replacement would resurrect dead proofs as spendable value.
 */
export type AppliedTokenTransition = Exclude<TokenStateTransition, { readonly _tag: "Recover" }>;

export interface TokenListFilter {
  /** Restrict to these states. */
  readonly states?: ReadonlyArray<TokenState>;
  /** Restrict to one mint (URL is normalized before matching). */
  readonly mintUrl?: string;
  /**
   * Include `state === "deleted"` rows (hidden by default — #33: deleted
   * rows are tombstones, hidden everywhere).
   */
  readonly includeDeleted?: boolean;
}

/** Spendable funding set for one send/melt at one mint. */
export interface SpendableSelection {
  /** All `accepted` records at the mint/unit, oldest first. */
  readonly records: ReadonlyArray<TokenRecord>;
  /** Sum of `records` amounts; always ≥ the requested amount. */
  readonly totalAmount: number;
}

export interface TokenValidationError {
  readonly _tag: "TokenValidationError";
  readonly reason: string;
}

export interface InvalidTokenIdError {
  readonly _tag: "InvalidTokenIdError";
  readonly id: string;
}

export interface TokenNotFoundError {
  readonly _tag: "TokenNotFoundError";
  readonly id: string;
}

/** Mirror of core's `IllegalTokenStateTransitionError` as plain data. */
export interface IllegalTokenTransitionError {
  readonly _tag: "IllegalTokenStateTransitionError";
  readonly from: TokenState;
  readonly transition: TokenStateTransition["_tag"];
}

export interface InsufficientSpendableFundsError {
  readonly _tag: "InsufficientSpendableFundsError";
  readonly mintUrl: string;
  readonly unit: string;
  readonly requested: number;
  readonly available: number;
}

export type TokenTransitionError =
  | InvalidTokenIdError
  | TokenNotFoundError
  | IllegalTokenTransitionError;

export interface TokensRepository {
  /** Persists a new token record; returns the storage-assigned id. */
  readonly insert: (
    token: NewCashuToken,
  ) => RepoResult<{ readonly id: string }, TokenValidationError>;
  /** The record with this id, or null (excludes purged rows). */
  readonly getById: (id: string) => Promise<TokenRecord | null>;
  /** Records matching the filter, newest first (token list, #38). */
  readonly list: (filter?: TokenListFilter) => Promise<ReadonlyArray<TokenRecord>>;
  /**
   * Applies one #33 transition to a stored record. Illegal (state, event)
   * pairs are rejected with the core error and NOTHING is persisted.
   */
  readonly transition: (
    id: string,
    transition: AppliedTokenTransition,
    atMillis: number,
  ) => Promise<RepoResult<TokenRecord, TokenTransitionError>>;
  /**
   * `error → accepted` recovery: applies core's `recoverTokenRecord`, which
   * also replaces the stored token/amount/mint/unit with the re-accepted
   * result (the old proofs were consumed by the recovery swap).
   */
  readonly recover: (
    id: string,
    reaccepted: ReceiveTokenResult,
    atMillis: number,
  ) => Promise<RepoResult<TokenRecord, TokenTransitionError>>;
  /**
   * Applies a batched NUT-07 checkstate partition (core
   * `reconcileTokenRecords`, keyed by record id) and persists every record
   * whose state changed. Unknown ids and no-op outcomes are skipped.
   */
  readonly reconcile: (
    partition: ProofGroupPartition<string>,
    atMillis: number,
  ) => Promise<{ readonly updated: ReadonlyArray<TokenRecord> }>;
  /**
   * Purges rows allowed by the #33 cleanup policy (`spent`/`deleted` past
   * the optional retention window): Evolu soft delete, rows disappear from
   * every query here. Returns the purged ids.
   */
  readonly purge: (
    nowMillis: number,
    policy?: PurgePolicy,
  ) => Promise<{ readonly purgedIds: ReadonlyArray<string> }>;
  /** Wallet balances over all stored records (core `computeWalletBalances`). */
  readonly balances: () => Promise<WalletBalances>;
  /**
   * Funding selection for "amount X at mint Y" (send/melt). Policy = the
   * PoC's: ALL `accepted` records at the (mint, unit) fund the operation
   * when their sum covers the amount (the engine swap consumes every input
   * and returns one NUT-08 change token, consolidating the wallet as a
   * side effect — `createSendTokenWithTokensAtMint` passes the whole mint
   * group in the PoC, and one payment never splits across mints). Fails
   * with the available total when the sum is short.
   */
  readonly selectSpendable: (args: {
    readonly mintUrl: string;
    readonly unit?: string;
    readonly amount: number;
  }) => Promise<RepoResult<SpendableSelection, InsufficientSpendableFundsError>>;
}

const formatTypeError = createFormatTypeError();

/** Casts a validated plain value to a branded query-builder value. */
const asParam = (value: string | number): never => value as never;

interface TokenRowLike {
  readonly id: unknown;
  readonly token: unknown;
  readonly mint: unknown;
  readonly unit: unknown;
  readonly amount: unknown;
  readonly state: unknown;
  readonly error: unknown;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
}

const parseMillis = (value: unknown): number => {
  const millis = Date.parse(String(value ?? ""));
  return Number.isFinite(millis) ? millis : 0;
};

/**
 * Maps a row to the core record. Rows with an unknown/null state (possible
 * for partially synced or PoC-era rows only — the column union rejects new
 * ones) read as `"error"`: not spendable, not counted in balances, and
 * recoverable via the explicit re-accept path.
 */
const toTokenRecord = (row: TokenRowLike): TokenRecord => {
  const createdAtMillis = parseMillis(row.createdAt);
  return {
    id: String(row.id),
    mintUrl: normalizeMintUrl(String(row.mint ?? "")),
    unit: String(row.unit ?? "").trim() || "sat",
    amount: Number(row.amount ?? 0),
    state: Option.getOrElse(normalizeTokenState(row.state), (): TokenState => "error"),
    token: String(row.token),
    error: row.error === null || row.error === undefined ? null : String(row.error),
    createdAtMillis,
    updatedAtMillis:
      row.updatedAt === null || row.updatedAt === undefined
        ? createdAtMillis
        : parseMillis(row.updatedAt),
  };
};

const toErrorColumn = (error: string | null): string | null => {
  if (error === null) return null;
  const trimmed = error.slice(0, ERROR_MAX_LENGTH);
  return trimmed.length === 0 ? null : trimmed;
};

export const createTokensRepository = (store: LinkyStore): TokensRepository => {
  const rowById = async (id: string) => {
    const query = store.evolu.createQuery((db) =>
      db
        .selectFrom("cashuToken")
        .selectAll()
        .where("isDeleted", "is not", 1)
        .where("id", "=", asParam(id))
        .limit(1),
    );
    const rows = await store.evolu.loadQuery(query);
    return rows[0] ?? null;
  };

  const loadRecord = async (
    id: string,
  ): Promise<RepoResult<TokenRecord, InvalidTokenIdError | TokenNotFoundError>> => {
    const parsedId = CashuTokenId.fromUnknown(id);
    if (!parsedId.ok) return repoErr({ _tag: "InvalidTokenIdError" as const, id });
    const row = await rowById(id);
    if (row === null) return repoErr({ _tag: "TokenNotFoundError" as const, id });
    return repoOk(toTokenRecord(row));
  };

  /** Persists the state/error of a transitioned record. */
  const persistTransitioned = (record: TokenRecord) =>
    store.update("cashuToken", {
      id: record.id as CashuTokenId,
      state: record.state,
      error: toErrorColumn(record.error),
    });

  const list = async (filter?: TokenListFilter): Promise<ReadonlyArray<TokenRecord>> => {
    const query = store.evolu.createQuery((db) => {
      let q = db.selectFrom("cashuToken").selectAll().where("isDeleted", "is not", 1);
      if (filter?.mintUrl !== undefined) {
        q = q.where("mint", "=", asParam(normalizeMintUrl(filter.mintUrl)));
      }
      return q.orderBy("createdAt", "desc").orderBy("id", "desc");
    });
    const rows = await store.evolu.loadQuery(query);
    let records = rows.map(toTokenRecord);
    if (filter?.states !== undefined) {
      const allowed = new Set(filter.states);
      records = records.filter((record) => allowed.has(record.state));
    } else if (filter?.includeDeleted !== true) {
      records = records.filter((record) => record.state !== "deleted");
    }
    return records;
  };

  return {
    insert: (token) => {
      const mintUrl = normalizeMintUrl(token.mintUrl);
      if (mintUrl === "") {
        return repoErr({
          _tag: "TokenValidationError" as const,
          reason: "mintUrl must be a non-empty URL",
        });
      }
      if (Option.isNone(normalizeTokenState(token.state))) {
        return repoErr({
          _tag: "TokenValidationError" as const,
          reason: `unknown token state: ${String(token.state)}`,
        });
      }
      const result = store.insert("cashuToken", {
        token: token.token,
        mint: mintUrl,
        unit: (token.unit ?? "").trim() || "sat",
        amount: token.amount,
        state: token.state,
        ...(token.error === undefined ? {} : { error: toErrorColumn(token.error) }),
      });
      if (!result.ok) {
        return repoErr({
          _tag: "TokenValidationError" as const,
          reason: formatTypeError(result.error as never),
        });
      }
      return repoOk({ id: String(result.value.id) });
    },

    getById: async (id) => {
      const loaded = await loadRecord(id);
      return loaded.ok ? loaded.value : null;
    },

    list,

    transition: async (id, transition, atMillis) => {
      const loaded = await loadRecord(id);
      if (!loaded.ok) return loaded;
      const transitioned = transitionTokenRecord(loaded.value, transition, atMillis);
      if (Either.isLeft(transitioned)) {
        const { from, transition: tag } = transitioned.left;
        return repoErr({
          _tag: "IllegalTokenStateTransitionError" as const,
          from,
          transition: tag,
        });
      }
      persistTransitioned(transitioned.right);
      return repoOk(transitioned.right);
    },

    recover: async (id, reaccepted, atMillis) => {
      const loaded = await loadRecord(id);
      if (!loaded.ok) return loaded;
      const recovered = recoverTokenRecord(loaded.value, reaccepted, atMillis);
      if (Either.isLeft(recovered)) {
        const { from, transition: tag } = recovered.left;
        return repoErr({
          _tag: "IllegalTokenStateTransitionError" as const,
          from,
          transition: tag,
        });
      }
      const record = recovered.right;
      store.update("cashuToken", {
        id: record.id as CashuTokenId,
        state: record.state,
        error: null,
        token: record.token,
        mint: record.mintUrl,
        unit: record.unit,
        amount: record.amount,
      });
      return repoOk(record);
    },

    reconcile: async (partition, atMillis) => {
      const ids = [
        ...partition.liveGroups.map((group) => group.id),
        ...partition.fullySpentIds,
        ...partition.unknownStateIds,
      ];
      if (ids.length === 0) return { updated: [] };

      const query = store.evolu.createQuery((db) =>
        db
          .selectFrom("cashuToken")
          .selectAll()
          .where("isDeleted", "is not", 1)
          .where("id", "in", ids.map(asParam)),
      );
      const rows = await store.evolu.loadQuery(query);
      const records = rows.map(toTokenRecord);
      const reconciled = reconcileTokenRecords(records, partition, atMillis);

      const updated: TokenRecord[] = [];
      for (let index = 0; index < records.length; index += 1) {
        const before = records[index]!;
        const after = reconciled[index]!;
        if (after.state === before.state && after.error === before.error) continue;
        persistTransitioned(after);
        updated.push(after);
      }
      return { updated };
    },

    purge: async (nowMillis, policy) => {
      // Purgeable states only (spent/deleted); the retention window is
      // checked per record against the storage-owned updatedAt.
      const query = store.evolu.createQuery((db) =>
        db
          .selectFrom("cashuToken")
          .selectAll()
          .where("isDeleted", "is not", 1)
          .where("state", "in", [asParam("spent"), asParam("deleted")]),
      );
      const rows = await store.evolu.loadQuery(query);
      const purgedIds: string[] = [];
      for (const row of rows) {
        const record = toTokenRecord(row);
        if (!isPurgeableTokenRecord(record, nowMillis, policy)) continue;
        store.update("cashuToken", { id: record.id as CashuTokenId, isDeleted: 1 });
        purgedIds.push(record.id);
      }
      return { purgedIds };
    },

    balances: async () => {
      const query = store.evolu.createQuery((db) =>
        db
          .selectFrom("cashuToken")
          .select(["mint", "unit", "amount", "state"])
          .where("isDeleted", "is not", 1),
      );
      const rows = await store.evolu.loadQuery(query);
      // Delegates ALL balance math to core (#33): non-counting states drop
      // out there; rows with unknown state read as "error" and never count.
      return computeWalletBalances(
        rows.map((row) => ({
          mintUrl: String(row.mint ?? ""),
          unit: String(row.unit ?? "").trim() || "sat",
          amount: Number(row.amount ?? 0),
          state: Option.getOrElse(normalizeTokenState(row.state), (): TokenState => "error"),
        })),
      );
    },

    selectSpendable: async ({ mintUrl, unit, amount }) => {
      const normalizedMint = normalizeMintUrl(mintUrl);
      const normalizedUnit = (unit ?? "").trim() || "sat";
      const query = store.evolu.createQuery((db) =>
        db
          .selectFrom("cashuToken")
          .selectAll()
          .where("isDeleted", "is not", 1)
          .where("state", "=", asParam("accepted"))
          .where("mint", "=", asParam(normalizedMint))
          .where("unit", "=", asParam(normalizedUnit))
          .orderBy("createdAt", "asc")
          .orderBy("id", "asc"),
      );
      const rows = await store.evolu.loadQuery(query);
      const records = rows.map(toTokenRecord);
      const totalAmount = records.reduce((sum, record) => sum + record.amount, 0);
      if (!Number.isFinite(amount) || amount <= 0 || totalAmount < amount) {
        return repoErr({
          _tag: "InsufficientSpendableFundsError" as const,
          mintUrl: normalizedMint,
          unit: normalizedUnit,
          requested: amount,
          available: totalAmount,
        });
      }
      return repoOk({ records, totalAmount });
    },
  };
};
