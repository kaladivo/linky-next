/**
 * Cashu token state model (issue #33) — the CORE-side contract for the
 * lifecycle of one stored token row. `evolu-store` (#35) persists this shape
 * (`cashuToken.state`), the wallet UI (#36+) renders it.
 *
 * The state list comes from the feature map (`docs/feature-map/cashu.md`,
 * "Token state determines balance and spendability") and the PoC
 * (`app/lib/cashuTokenState.ts`), extended with explicit `spent` and
 * `deleted` states (the PoC encodes those as error-message patterns and an
 * `isDeleted` flag — established Cashu wallet convention is an explicit
 * state).
 *
 * State meanings (one-liner each):
 *
 * - `accepted`     — held by the wallet, proofs believed UNSPENT at the mint;
 *                    the only spendable state (`cashu.accept-token`).
 * - `issued`       — outgoing token emitted for an amount, waiting to be
 *                    claimed by the recipient (`cashu.emit-token`).
 * - `pending`      — outgoing token whose delivery is still in flight
 *                    (e.g. chat send awaiting relay confirmation).
 * - `reserved`     — deliberately set aside / unavailable: manual
 *                    support-repair or funding an in-flight melt
 *                    (`cashu.reserve-token`).
 * - `externalized` — the token lives outside the wallet (NFC tag, shared
 *                    link); excluded from available balance
 *                    (`cashu.externalize-token`).
 * - `spent`        — proofs confirmed SPENT at the mint (NUT-07): claimed by
 *                    a recipient or consumed by a swap/melt; dead value.
 * - `deleted`      — soft-deleted locally (user delete or cleanup); hidden
 *                    everywhere, kept only as a tombstone.
 * - `error`        — last validation/operation failed (message kept on the
 *                    record); not spendable until recovered.
 *
 * Transitions are typed events; illegal (state, event) pairs are rejected
 * with {@link IllegalTokenStateTransitionError} — never silently applied.
 *
 * ```text
 *                       emit                    markInFlight
 *            accepted ───────────▶ issued ─────────────────▶ pending
 *            ▲ │ │ ▲                 │ │                        │
 *    return/ │ │ │ └────────────────┘ │ (return)               │ (return)
 *    recover │ │ │      externalize   │                        │
 *            │ │ └──────────────────▶ externalized ◀──────────┘ (never)
 *            │ │  reserve                  │
 *            │ └────────▶ reserved ────────┤ (return)
 *            │                             │
 *            └─────────────────────────────┘
 *
 *   markSpent: accepted | issued | pending | reserved | externalized | error → spent
 *   markError: accepted | issued | pending | reserved | externalized → error
 *   recover:   error → accepted          (after a successful re-accept)
 *   delete:    any state except deleted → deleted
 *   spent and deleted are terminal (spent can still be deleted by cleanup).
 * ```
 */
import { Data, Option } from "effect";

export const TOKEN_STATES = [
  "accepted",
  "issued",
  "pending",
  "reserved",
  "externalized",
  "spent",
  "deleted",
  "error",
] as const;

export type TokenState = (typeof TOKEN_STATES)[number];

/**
 * Parses an untrusted state string (e.g. the `cashuToken.state` column or a
 * PoC-era row) into the typed union. Unknown / empty values are `none` —
 * the storage mapper decides the fallback, not this module.
 */
export const normalizeTokenState = (value: unknown): Option.Option<TokenState> => {
  const normalized = String(value ?? "").trim();
  return (TOKEN_STATES as ReadonlyArray<string>).includes(normalized)
    ? Option.some(normalized as TokenState)
    : Option.none();
};

// ---------------------------------------------------------------------------
// Transition events
// ---------------------------------------------------------------------------

/**
 * Every way a token record's state may legally change. Events carry their
 * payload (only `markError` has one); the legal source states per event are
 * in {@link TOKEN_STATE_TRANSITIONS}.
 */
/* eslint-disable @typescript-eslint/no-empty-object-type -- `{}` is
   Data.TaggedEnum's required encoding for payload-less variants. */
export type TokenStateTransition = Data.TaggedEnum<{
  /** Turn a stored (accepted) token into an outgoing one (`cashu.emit-token`). */
  Emit: {};
  /** The issued token's delivery started and is awaiting confirmation. */
  MarkInFlight: {};
  /** Manually set an accepted token aside (`cashu.reserve-token`), incl. melt funding. */
  Reserve: {};
  /** Move the token outside the wallet — NFC write / share (`cashu.externalize-token`). */
  Externalize: {};
  /** Bring an outgoing/unavailable token back to the wallet (`cashu.return-token`). */
  Return: {};
  /** Proofs confirmed SPENT at the mint (claim detected, swap consumed them). */
  MarkSpent: {};
  /** A validation/operation failed definitively; keep the message for the user. */
  MarkError: { readonly message: string };
  /** Error recovery succeeded (token re-accepted at the mint). */
  Recover: {};
  /** Soft-delete the record (user delete, `cashu.cleanup-spent`). */
  Delete: {};
}>;
/* eslint-enable @typescript-eslint/no-empty-object-type */

export const TokenStateTransition = Data.taggedEnum<TokenStateTransition>();

export type TokenStateTransitionTag = TokenStateTransition["_tag"];

interface TransitionRule {
  readonly from: ReadonlySet<TokenState>;
  readonly to: TokenState;
}

const rule = (from: ReadonlyArray<TokenState>, to: TokenState): TransitionRule => ({
  from: new Set(from),
  to,
});

/**
 * The full legal-transition table. Anything not listed here is illegal and
 * is rejected by {@link nextTokenState}.
 */
export const TOKEN_STATE_TRANSITIONS: Readonly<Record<TokenStateTransitionTag, TransitionRule>> = {
  Emit: rule(["accepted"], "issued"),
  MarkInFlight: rule(["issued"], "pending"),
  Reserve: rule(["accepted"], "reserved"),
  Externalize: rule(["accepted", "issued"], "externalized"),
  Return: rule(["issued", "pending", "reserved", "externalized"], "accepted"),
  MarkSpent: rule(["accepted", "issued", "pending", "reserved", "externalized", "error"], "spent"),
  MarkError: rule(["accepted", "issued", "pending", "reserved", "externalized"], "error"),
  Recover: rule(["error"], "accepted"),
  Delete: rule(
    ["accepted", "issued", "pending", "reserved", "externalized", "spent", "error"],
    "deleted",
  ),
};

/** Rejected (state, event) pair — the transition is not in the legal table. */
export class IllegalTokenStateTransitionError extends Data.TaggedError(
  "IllegalTokenStateTransitionError",
)<{
  readonly from: TokenState;
  readonly transition: TokenStateTransitionTag;
}> {}

/** True when `transition` may be applied to a token in state `from`. */
export const canTransitionTokenState = (
  from: TokenState,
  transition: TokenStateTransitionTag,
): boolean => TOKEN_STATE_TRANSITIONS[transition].from.has(from);

/**
 * Pure state-level step function. Record-level transitions (timestamps,
 * error message bookkeeping) build on this — see `tokenRecord.ts`.
 */
export const nextTokenState = (
  from: TokenState,
  transition: TokenStateTransitionTag,
): Option.Option<TokenState> =>
  canTransitionTokenState(from, transition)
    ? Option.some(TOKEN_STATE_TRANSITIONS[transition].to)
    : Option.none();

// ---------------------------------------------------------------------------
// State classification (balance + cleanup semantics live on the state)
// ---------------------------------------------------------------------------

/**
 * Spendable = immediately usable to fund a send/melt. Feature-map contract:
 * "issued, pending, reserved, externalized, spent, deleted, and error tokens
 * are not spendable" — which leaves exactly `accepted`.
 */
export const SPENDABLE_TOKEN_STATES: ReadonlySet<TokenState> = new Set(["accepted"]);

/**
 * Counts toward the TOTAL balance = value the wallet still tracks as its
 * own (spendable or temporarily unavailable but returnable). Excluded:
 * `spent` / `deleted` (gone) and `error` (unverified value — it re-enters
 * the total via `Recover` once a re-accept proves it).
 */
export const TOTAL_BALANCE_TOKEN_STATES: ReadonlySet<TokenState> = new Set([
  "accepted",
  "issued",
  "pending",
  "reserved",
  "externalized",
]);

/** States cleanup (`cashu.cleanup-spent`) may purge from local storage. */
export const PURGEABLE_TOKEN_STATES: ReadonlySet<TokenState> = new Set(["spent", "deleted"]);

export const isSpendableTokenState = (state: TokenState): boolean =>
  SPENDABLE_TOKEN_STATES.has(state);

export const countsTowardTotalBalance = (state: TokenState): boolean =>
  TOTAL_BALANCE_TOKEN_STATES.has(state);

export const isPurgeableTokenState = (state: TokenState): boolean =>
  PURGEABLE_TOKEN_STATES.has(state);
