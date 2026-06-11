/**
 * TokenRecord — the canonical persisted shape of one Cashu token row
 * (issue #33). `evolu-store` (#35) maps this to the `cashuToken` table, the
 * wallet surfaces (#36+) render it. All functions here are pure: time enters
 * as an explicit `atMillis` argument (callers use Effect `Clock`), ids are
 * supplied by the caller (storage owns id generation).
 *
 * How the #32 engine operations map to records/transitions:
 *
 * - `receiveToken`      → {@link tokenRecordFromReceive} (new `accepted` row).
 * - `createSendToken`   → {@link tokenRecordsFromSend}: the send token becomes
 *   a new `issued` row, NUT-08 change (`keepToken`) a new `accepted` row, and
 *   the funding rows' proofs were consumed by the swap → `MarkSpent` them.
 * - `claimTopup`        → {@link tokenRecordFromTopup} (new `accepted` row).
 * - `restoreFromMint`   → {@link tokenRecordsFromRestore} (`accepted` rows).
 * - `payInvoice` (melt) → `Reserve` the funding rows before the melt; on
 *   success `MarkSpent` them and store the change via
 *   {@link tokenRecordFromMeltChange}; on failure `Return` them.
 * - `checkProofStates` / `partitionProofGroupsByState` →
 *   {@link reconcileTokenRecords} (pending/issued/externalized ↔ spent
 *   reconciliation, see {@link reconcileTokenRecord}).
 */
import { Either, Option } from "effect";

import { normalizeMintUrl } from "../../ports/CounterStore.js";
import type { ClaimTopupResult } from "./topup.js";
import type { CreateSendTokenResult } from "./sendToken.js";
import type { PayInvoiceResult } from "./meltToken.js";
import type { ProofGroupPartition } from "./proofStates.js";
import type { ReceiveTokenResult } from "./receiveToken.js";
import type { RestoreFromMintResult } from "./restore.js";
import type { TokenState, TokenStateTransition } from "./tokenState.js";
import {
  IllegalTokenStateTransitionError,
  TokenStateTransition as Transition,
  canTransitionTokenState,
  isPurgeableTokenState,
  TOKEN_STATE_TRANSITIONS,
} from "./tokenState.js";

/**
 * One stored token row. `token` is the CURRENT serialized Cashu token (the
 * post-swap encoding over proofs the wallet controls) — a bearer secret:
 * never log it, never embed it in errors.
 */
export interface TokenRecord {
  readonly id: string;
  /** Normalized mint URL (see `normalizeMintUrl`). */
  readonly mintUrl: string;
  /** Currency unit, e.g. "sat". */
  readonly unit: string;
  /** Sum of the token's proof amounts in `unit`. */
  readonly amount: number;
  readonly state: TokenState;
  /** Serialized Cashu token (V3/V4) holding the record's proofs. */
  readonly token: string;
  /** Last error message; only meaningful while `state === "error"`. */
  readonly error: string | null;
  readonly createdAtMillis: number;
  readonly updatedAtMillis: number;
}

export interface NewTokenRecordMeta {
  /** Storage-assigned id for the new row. */
  readonly id: string;
  /** Creation time (Effect `Clock.currentTimeMillis` at the call site). */
  readonly atMillis: number;
}

const makeRecord = (args: {
  readonly meta: NewTokenRecordMeta;
  readonly mintUrl: string;
  readonly unit: string;
  readonly amount: number;
  readonly token: string;
  readonly state: TokenState;
}): TokenRecord => ({
  id: args.meta.id,
  mintUrl: normalizeMintUrl(args.mintUrl),
  unit: args.unit.trim() || "sat",
  amount: args.amount,
  state: args.state,
  token: args.token,
  error: null,
  createdAtMillis: args.meta.atMillis,
  updatedAtMillis: args.meta.atMillis,
});

// ---------------------------------------------------------------------------
// Constructors — one per #32 engine operation that produces wallet value
// ---------------------------------------------------------------------------

/** `receiveToken` succeeded → store the re-swapped token as `accepted`. */
export const tokenRecordFromReceive = (
  result: ReceiveTokenResult,
  meta: NewTokenRecordMeta,
): TokenRecord =>
  makeRecord({
    meta,
    mintUrl: result.mintUrl,
    unit: result.unit,
    amount: result.amount,
    token: result.token,
    state: "accepted",
  });

export interface SendTokenRecordsMeta {
  /** Id for the outgoing (`issued`) row. */
  readonly issuedId: string;
  /** Id for the change (`accepted`) row; unused when there is no change. */
  readonly keepId: string;
  readonly atMillis: number;
}

export interface SendTokenRecords {
  /** The emitted token, waiting to be claimed. */
  readonly issued: TokenRecord;
  /** NUT-08 change kept by the wallet, when the swap produced any. */
  readonly keep: Option.Option<TokenRecord>;
}

/**
 * `createSendToken` succeeded → an `issued` row for the outgoing token and
 * (when the inputs did not match exactly) an `accepted` row for the change.
 * The funding rows that paid for the swap are now spent at the mint — apply
 * `MarkSpent` to them separately.
 */
export const tokenRecordsFromSend = (
  result: CreateSendTokenResult,
  meta: SendTokenRecordsMeta,
): SendTokenRecords => ({
  issued: makeRecord({
    meta: { id: meta.issuedId, atMillis: meta.atMillis },
    mintUrl: result.mintUrl,
    unit: result.unit,
    amount: result.sendAmount,
    token: result.sendToken,
    state: "issued",
  }),
  keep: Option.map(result.keepToken, (keepToken) =>
    makeRecord({
      meta: { id: meta.keepId, atMillis: meta.atMillis },
      mintUrl: result.mintUrl,
      unit: result.unit,
      amount: result.keepAmount,
      token: keepToken,
      state: "accepted",
    }),
  ),
});

/** `claimTopup` succeeded → store the minted proofs as `accepted`. */
export const tokenRecordFromTopup = (
  result: ClaimTopupResult,
  meta: NewTokenRecordMeta,
): TokenRecord =>
  makeRecord({
    meta,
    mintUrl: result.mintUrl,
    unit: result.unit,
    amount: result.amount,
    token: result.token,
    state: "accepted",
  });

/**
 * `payInvoice` succeeded → the NUT-08 change (when any) becomes a fresh
 * `accepted` row; the reserved funding rows are `MarkSpent` by the caller.
 */
export const tokenRecordFromMeltChange = (
  result: PayInvoiceResult,
  meta: NewTokenRecordMeta,
): Option.Option<TokenRecord> =>
  Option.map(result.changeToken, (changeToken) =>
    makeRecord({
      meta,
      mintUrl: result.mintUrl,
      unit: result.unit,
      amount: result.changeAmount,
      token: changeToken,
      state: "accepted",
    }),
  );

/**
 * `restoreFromMint` recovered value → one `accepted` row per restored token
 * (the engine already filtered to currently-UNSPENT proofs). `idFor` assigns
 * the storage id for each restored token (by its array index).
 */
export const tokenRecordsFromRestore = (
  result: RestoreFromMintResult,
  meta: { readonly idFor: (index: number) => string; readonly atMillis: number },
): ReadonlyArray<TokenRecord> =>
  result.restoredTokens.map((restored, index) =>
    makeRecord({
      meta: { id: meta.idFor(index), atMillis: meta.atMillis },
      mintUrl: restored.mintUrl,
      unit: restored.unit,
      amount: restored.amount,
      token: restored.token,
      state: "accepted",
    }),
  );

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * Applies one typed transition to a record. Illegal (state, event) pairs are
 * rejected with {@link IllegalTokenStateTransitionError}; legal ones update
 * `state`, `updatedAtMillis` and the error message (`MarkError` sets it,
 * every transition leaving `error` — and any transition to a non-error
 * state — clears it).
 */
export const transitionTokenRecord = (
  record: TokenRecord,
  transition: TokenStateTransition,
  atMillis: number,
): Either.Either<TokenRecord, IllegalTokenStateTransitionError> => {
  if (!canTransitionTokenState(record.state, transition._tag)) {
    return Either.left(
      new IllegalTokenStateTransitionError({ from: record.state, transition: transition._tag }),
    );
  }
  const to = TOKEN_STATE_TRANSITIONS[transition._tag].to;
  return Either.right({
    ...record,
    state: to,
    error: transition._tag === "MarkError" ? transition.message : null,
    updatedAtMillis: atMillis,
  });
};

type Transitioned = Either.Either<TokenRecord, IllegalTokenStateTransitionError>;

/** `accepted → issued` — emit a stored token (`cashu.emit-token`). */
export const markTokenRecordIssued = (record: TokenRecord, atMillis: number): Transitioned =>
  transitionTokenRecord(record, Transition.Emit(), atMillis);

/** `issued → pending` — delivery started, awaiting confirmation. */
export const markTokenRecordInFlight = (record: TokenRecord, atMillis: number): Transitioned =>
  transitionTokenRecord(record, Transition.MarkInFlight(), atMillis);

/** `accepted → reserved` — set aside (`cashu.reserve-token`, melt funding). */
export const reserveTokenRecord = (record: TokenRecord, atMillis: number): Transitioned =>
  transitionTokenRecord(record, Transition.Reserve(), atMillis);

/** `accepted | issued → externalized` — NFC write / share. */
export const externalizeTokenRecord = (record: TokenRecord, atMillis: number): Transitioned =>
  transitionTokenRecord(record, Transition.Externalize(), atMillis);

/** `issued | pending | reserved | externalized → accepted` (`cashu.return-token`). */
export const returnTokenRecordToWallet = (record: TokenRecord, atMillis: number): Transitioned =>
  transitionTokenRecord(record, Transition.Return(), atMillis);

/** any live state | error `→ spent` — proofs confirmed SPENT at the mint. */
export const markTokenRecordSpent = (record: TokenRecord, atMillis: number): Transitioned =>
  transitionTokenRecord(record, Transition.MarkSpent(), atMillis);

/** any live state `→ error` — definitive failure, message kept on the row. */
export const markTokenRecordError = (
  record: TokenRecord,
  message: string,
  atMillis: number,
): Transitioned => transitionTokenRecord(record, Transition.MarkError({ message }), atMillis);

/**
 * `error → accepted` — a re-accept at the mint succeeded. The fresh
 * `receiveToken` result replaces the stored token/amount (the old proofs
 * were consumed by the recovery swap).
 */
export const recoverTokenRecord = (
  record: TokenRecord,
  reaccepted: ReceiveTokenResult,
  atMillis: number,
): Transitioned =>
  Either.map(transitionTokenRecord(record, Transition.Recover(), atMillis), (recovered) => ({
    ...recovered,
    mintUrl: normalizeMintUrl(reaccepted.mintUrl),
    unit: reaccepted.unit.trim() || "sat",
    amount: reaccepted.amount,
    token: reaccepted.token,
  }));

/** any state except `deleted` `→ deleted` — soft delete. */
export const deleteTokenRecord = (record: TokenRecord, atMillis: number): Transitioned =>
  transitionTokenRecord(record, Transition.Delete(), atMillis);

// ---------------------------------------------------------------------------
// NUT-07 reconciliation (`cashu.validate-token`, `cashu.cleanup-spent`)
// ---------------------------------------------------------------------------

/** Per-record outcome of a batched NUT-07 checkstate, see `proofStates.ts`. */
export type ProofStateOutcome = "live" | "spent" | "unknown";

/**
 * Folds one checkstate outcome into a record — total (never fails; an
 * outcome that does not apply to the current state leaves the record
 * untouched, e.g. a `spent` report for an already-deleted row):
 *
 * - `spent`   → `MarkSpent` wherever legal: an `issued`/`pending`/
 *   `externalized` token was claimed by its recipient, an `accepted`/
 *   `reserved` one was consumed elsewhere (other device), an `error` row is
 *   confirmed dead.
 * - `live`    → `pending → accepted` (the in-flight send is confirmed
 *   undelivered and the value is provably still ours — issue contract
 *   "checkProofStates outcomes drive pending→spent/accepted
 *   reconciliation"). Every other state keeps its meaning: `issued`/
 *   `externalized` stay out waiting to be claimed, `error` recovery needs an
 *   explicit re-accept (`Recover`).
 * - `unknown` → no change (mint PENDING/missing states prove nothing; never
 *   treat unknown as spent).
 */
export const reconcileTokenRecord = (
  record: TokenRecord,
  outcome: ProofStateOutcome,
  atMillis: number,
): TokenRecord => {
  const attempt = (transition: TokenStateTransition): TokenRecord =>
    Either.getOrElse(transitionTokenRecord(record, transition, atMillis), () => record);

  switch (outcome) {
    case "spent":
      return attempt(Transition.MarkSpent());
    case "live":
      return record.state === "pending" ? attempt(Transition.Return()) : record;
    case "unknown":
      return record;
  }
};

/**
 * Applies a batched {@link ProofGroupPartition} (keyed by record id) to a
 * record collection. Records not covered by the partition are returned
 * unchanged. Note: `liveGroups` membership means "has ≥ 1 UNSPENT proof";
 * rows in it are reconciled as `live`.
 */
export const reconcileTokenRecords = (
  records: ReadonlyArray<TokenRecord>,
  partition: ProofGroupPartition<string>,
  atMillis: number,
): ReadonlyArray<TokenRecord> => {
  const outcomeById = new Map<string, ProofStateOutcome>();
  for (const group of partition.liveGroups) outcomeById.set(group.id, "live");
  for (const id of partition.fullySpentIds) outcomeById.set(id, "spent");
  for (const id of partition.unknownStateIds) outcomeById.set(id, "unknown");

  return records.map((record) => {
    const outcome = outcomeById.get(record.id);
    return outcome === undefined ? record : reconcileTokenRecord(record, outcome, atMillis);
  });
};

// ---------------------------------------------------------------------------
// Error recovery classification
// ---------------------------------------------------------------------------

/**
 * Error-message patterns that mean the proofs are definitively dead at the
 * mint (PoC `isCashuTokenDefinitivelySpent` / `useCashuTokenChecks`).
 * Matching is for legacy/PoC-era rows whose spentness was encoded in the
 * message — the engine itself marks `spent` directly.
 */
const DEFINITIVELY_SPENT_ERROR_PATTERNS: ReadonlyArray<string> = [
  "token already spent",
  "proofs already spent",
  "invalid proof",
  "invalid proofs",
  "token proofs missing",
  "invalid token",
];

export const isDefinitivelySpentErrorMessage = (message: string): boolean => {
  const normalized = message.trim().toLowerCase();
  if (normalized === "") return false;
  return DEFINITIVELY_SPENT_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
};

/**
 * Recovery path for an `error` record (`none` for any other state):
 *
 * - `"mark-spent"` — the message proves the proofs are dead; `MarkSpent`
 *   (then cleanup may purge it).
 * - `"reaccept"`   — worth retrying: re-accept at the mint, then `Recover`
 *   on success.
 */
export const tokenRecordErrorRecovery = (
  record: TokenRecord,
): Option.Option<"mark-spent" | "reaccept"> =>
  record.state === "error"
    ? Option.some(isDefinitivelySpentErrorMessage(record.error ?? "") ? "mark-spent" : "reaccept")
    : Option.none();

// ---------------------------------------------------------------------------
// Cleanup policy (`cashu.cleanup-spent`)
// ---------------------------------------------------------------------------

export interface PurgePolicy {
  /**
   * Keep purgeable rows around this long after their last state change
   * (audit/debug window). Default 0 — purge immediately.
   */
  readonly minAgeMillis?: number;
}

/**
 * True when cleanup may physically remove this row now: the state is
 * purgeable (`spent` — claimed/consumed entries — or `deleted`) and the
 * optional retention window has passed.
 */
export const isPurgeableTokenRecord = (
  record: TokenRecord,
  nowMillis: number,
  policy?: PurgePolicy,
): boolean =>
  isPurgeableTokenState(record.state) &&
  nowMillis - record.updatedAtMillis >= (policy?.minAgeMillis ?? 0);

/** The subset of `records` cleanup may purge now, order preserved. */
export const selectPurgeableTokenRecords = (
  records: ReadonlyArray<TokenRecord>,
  nowMillis: number,
  policy?: PurgePolicy,
): ReadonlyArray<TokenRecord> =>
  records.filter((record) => isPurgeableTokenRecord(record, nowMillis, policy));
