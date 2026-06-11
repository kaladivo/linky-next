/**
 * Top-up over Lightning — `cashu.topup-quote` / `cashu.claim-topup` in the
 * feature map: create a mint quote (invoice), poll its state on demand, and
 * claim the minted proofs once paid.
 *
 * Quote state machine: `UNPAID → PAID → ISSUED`, with `EXPIRED` derived
 * locally (mint says UNPAID and the expiry timestamp has passed — checked
 * against Effect's `Clock`). Claimable states are PAID **and** ISSUED
 * (PoC `isClaimableMintQuoteState`): an already-issued quote remains
 * claim-relevant because the proofs may have been minted by a prior session
 * whose result was lost — the deterministic recovery below re-derives them.
 *
 * Claim retry ladder (PoC `mintTopupProofs`):
 *
 * - OutputsArePending (11004): fixed +64 bump, retry (max 5) — NUT-09
 *   restore cannot surface unsigned promises.
 * - OutputsAlreadySigned (11005): disambiguate via NUT-09 restore:
 *   - RECOVERY: the restored proofs are spendable and cover the amount —
 *     the quote was issued in a prior session; return them (prefer an
 *     exact-amount subset) and jump the counter past the signed range.
 *   - COLLISION: the signed range belongs to an unrelated past operation
 *     (proofs spent); the quote is still PAID — jump past the range and
 *     retry mintProofs with fresh outputs (max 5).
 */
import type { Proof } from "@cashu/cashu-ts";
import { Clock, Effect } from "effect";

import type { CounterStoreError, KeysetRef } from "../../ports/CounterStore.js";
import { CounterStore } from "../../ports/CounterStore.js";
import type { HttpClient } from "../../ports/index.js";
import type { CashuSeed } from "../identity/DerivedIdentities.js";
import type {
  CashuMintFailure,
  InvalidCashuTokenError,
  KeysetUnavailableError,
} from "./errors.js";
import {
  InvalidAmountError,
  MintQuoteNotClaimableError,
  isOutputsAlreadySignedFailure,
  isOutputsPendingFailure,
} from "./errors.js";
import {
  COLLISION_BUMP,
  MAX_COLLISION_ATTEMPTS,
  effectiveCounter,
  keysetRefOf,
} from "./internal/deterministic.js";
import type { WalletHandle } from "./internal/wallet.js";
import { loadWallet, runMintCall } from "./internal/wallet.js";
import { filterUnspentProofs } from "./proofStates.js";
import type { CashuProof } from "./tokenCodec.js";
import { encodeCashuToken, sumProofAmounts } from "./tokenCodec.js";

export type TopupQuoteState = "UNPAID" | "PAID" | "ISSUED" | "EXPIRED";

export interface TopupQuote {
  readonly mintUrl: string;
  readonly unit: string;
  readonly amount: number;
  readonly quoteId: string;
  /** BOLT11 invoice to display/pay. */
  readonly invoice: string;
  /** Unix seconds; 0 when the mint reports none. */
  readonly expiresAt: number;
  readonly state: TopupQuoteState;
}

const normalizeQuoteState = (raw: unknown): "UNPAID" | "PAID" | "ISSUED" | null => {
  const state = String(raw ?? "")
    .trim()
    .toUpperCase();
  return state === "UNPAID" || state === "PAID" || state === "ISSUED" ? state : null;
};

/** Local expiry: an UNPAID quote whose expiry passed is EXPIRED. */
const withLocalExpiry = (
  state: "UNPAID" | "PAID" | "ISSUED" | null,
  expiresAt: number,
): Effect.Effect<TopupQuoteState | "UNKNOWN"> =>
  Effect.gen(function* () {
    if (state === null) return "UNKNOWN" as const;
    if (state !== "UNPAID") return state;
    if (expiresAt <= 0) return state;
    const now = yield* Clock.currentTimeMillis;
    return now >= expiresAt * 1000 ? ("EXPIRED" as const) : state;
  });

// ---------------------------------------------------------------------------
// Create quote
// ---------------------------------------------------------------------------

export interface CreateTopupQuoteArgs {
  readonly mintUrl: string;
  readonly amount: number;
  readonly unit?: string | undefined;
  readonly description?: string | undefined;
}

export const createTopupQuote = (
  args: CreateTopupQuoteArgs,
): Effect.Effect<
  TopupQuote,
  InvalidAmountError | KeysetUnavailableError | CashuMintFailure,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const amount = Number.isFinite(args.amount) ? Math.trunc(args.amount) : 0;
    if (amount <= 0) return yield* Effect.fail(new InvalidAmountError({ amount: args.amount }));

    const handle = yield* loadWallet({ mintUrl: args.mintUrl, unit: args.unit });
    const quote = yield* runMintCall(handle.mintUrl, () =>
      handle.wallet.createMintQuote(amount, args.description),
    );

    const expiresAt = Number.isFinite(quote.expiry) ? Math.trunc(quote.expiry) : 0;
    const state = yield* withLocalExpiry(normalizeQuoteState(quote.state), expiresAt);
    return {
      mintUrl: handle.mintUrl,
      unit: handle.unit,
      amount,
      quoteId: quote.quote,
      invoice: quote.request,
      expiresAt,
      state: state === "UNKNOWN" ? "UNPAID" : state,
    };
  });

// ---------------------------------------------------------------------------
// Check quote (recheck on demand)
// ---------------------------------------------------------------------------

export interface CheckTopupQuoteArgs {
  readonly mintUrl: string;
  readonly quoteId: string;
  readonly unit?: string | undefined;
}

export interface TopupQuoteStatus {
  readonly mintUrl: string;
  readonly quoteId: string;
  readonly state: TopupQuoteState | "UNKNOWN";
  readonly expiresAt: number;
  /** PAID or ISSUED — worth attempting a claim. */
  readonly claimable: boolean;
}

export const checkTopupQuote = (
  args: CheckTopupQuoteArgs,
): Effect.Effect<
  TopupQuoteStatus,
  KeysetUnavailableError | CashuMintFailure,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const handle = yield* loadWallet({ mintUrl: args.mintUrl, unit: args.unit });
    const status = yield* runMintCall(handle.mintUrl, () =>
      handle.wallet.checkMintQuote(args.quoteId),
    );
    const mintState = normalizeQuoteState(status.state);
    const expiresAt = Number.isFinite(status.expiry) ? Math.trunc(status.expiry) : 0;
    const state = yield* withLocalExpiry(mintState, expiresAt);
    return {
      mintUrl: handle.mintUrl,
      quoteId: args.quoteId,
      state,
      expiresAt,
      claimable: mintState === "PAID" || mintState === "ISSUED",
    };
  });

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

export interface ClaimTopupArgs {
  readonly seed: CashuSeed;
  readonly mintUrl: string;
  readonly quoteId: string;
  readonly amount: number;
  readonly unit?: string | undefined;
}

export interface ClaimTopupResult {
  readonly mintUrl: string;
  readonly unit: string;
  readonly amount: number;
  readonly proofs: ReadonlyArray<CashuProof>;
  readonly token: string;
  /** True when the proofs were recovered via NUT-09 (prior-session issue). */
  readonly recovered: boolean;
}

export type ClaimTopupError =
  | InvalidAmountError
  | MintQuoteNotClaimableError
  | KeysetUnavailableError
  | InvalidCashuTokenError
  | CashuMintFailure
  | CounterStoreError;

/** Exact-amount subset of proofs, preferring fewer/larger denominations (PoC). */
const findExactSubsetByAmount = (proofs: Proof[], target: number): Proof[] | null => {
  if (target <= 0) return null;
  const indexed = proofs
    .map((proof, idx) => ({ idx, amount: Number(proof.amount ?? 0) || 0, proof }))
    .filter((entry) => entry.amount > 0 && entry.amount <= target)
    .sort((a, b) => b.amount - a.amount);
  if (indexed.length === 0) return null;

  const memo = new Set<string>();
  const dfs = (start: number, remaining: number): Proof[] | null => {
    if (remaining === 0) return [];
    if (start >= indexed.length) return null;
    const memoKey = `${start}|${remaining}`;
    if (memo.has(memoKey)) return null;
    for (let i = start; i < indexed.length; i += 1) {
      const entry = indexed[i];
      if (entry === undefined || entry.amount > remaining) continue;
      const rest = dfs(i + 1, remaining - entry.amount);
      if (rest !== null) return [entry.proof, ...rest];
    }
    memo.add(memoKey);
    return null;
  };

  return dfs(0, target);
};

type RestoredClassification =
  | { readonly kind: "recovery"; readonly proofs: Proof[]; readonly lastSigned: number | null }
  | { readonly kind: "collision"; readonly lastSigned: number | null }
  | { readonly kind: "empty" };

const classifyAlreadySigned = (args: {
  readonly handle: WalletHandle;
  readonly amount: number;
  readonly counter: number;
}): Effect.Effect<RestoredClassification, CashuMintFailure> =>
  Effect.gen(function* () {
    const { handle, amount, counter } = args;
    const restored = yield* runMintCall(handle.mintUrl, () =>
      handle.wallet.restore(counter, 100, { keysetId: handle.keysetId }),
    );
    const lastSigned =
      typeof restored.lastCounterWithSignature === "number" &&
      Number.isFinite(restored.lastCounterWithSignature)
        ? restored.lastCounterWithSignature
        : null;

    if (restored.proofs.length === 0) return { kind: "empty" } as const;

    const spendable = yield* runMintCall(handle.mintUrl, () =>
      handle.wallet.checkProofsStates(restored.proofs),
    ).pipe(
      Effect.map((states) => filterUnspentProofs(restored.proofs, states)),
      Effect.orElseSucceed(() => restored.proofs),
    );

    if (sumProofAmounts(spendable) < amount) {
      // Signed range exists but is (mostly) spent: an unrelated past
      // operation. The current quote is still PAID at the mint.
      return { kind: "collision", lastSigned } as const;
    }

    const exact = findExactSubsetByAmount(spendable, amount);
    return { kind: "recovery", proofs: exact ?? spendable, lastSigned } as const;
  });

export const claimTopup = (
  args: ClaimTopupArgs,
): Effect.Effect<ClaimTopupResult, ClaimTopupError, HttpClient.HttpClient | CounterStore> =>
  Effect.gen(function* () {
    const amount = Number.isFinite(args.amount) ? Math.trunc(args.amount) : 0;
    if (amount <= 0) return yield* Effect.fail(new InvalidAmountError({ amount: args.amount }));

    const counters = yield* CounterStore;
    const handle = yield* loadWallet({ mintUrl: args.mintUrl, unit: args.unit, seed: args.seed });
    const ref = keysetRefOf(handle);

    // Gate on a claimable quote state (recheck on demand).
    const status = yield* runMintCall(handle.mintUrl, () =>
      handle.wallet.checkMintQuote(args.quoteId),
    );
    const mintState = normalizeQuoteState(status.state);
    if (mintState !== "PAID" && mintState !== "ISSUED") {
      const expiresAt = Number.isFinite(status.expiry) ? Math.trunc(status.expiry) : 0;
      const local = yield* withLocalExpiry(mintState, expiresAt);
      return yield* Effect.fail(
        new MintQuoteNotClaimableError({
          mintUrl: handle.mintUrl,
          quoteId: args.quoteId,
          state: local === "UNPAID" || local === "EXPIRED" ? local : "UNKNOWN",
        }),
      );
    }

    const claimAttempts = mintProofsWithRecovery({ handle, ref, amount, quoteId: args.quoteId });

    const { proofs, recovered } = yield* counters.withCounterLock(ref, claimAttempts);

    const token = yield* encodeCashuToken({
      mintUrl: handle.mintUrl,
      proofs,
      unit: handle.unit,
    });

    return {
      mintUrl: handle.mintUrl,
      unit: handle.unit,
      amount: sumProofAmounts(proofs),
      proofs,
      token,
      recovered,
    };
  });

const mintProofsWithRecovery = (args: {
  readonly handle: WalletHandle;
  readonly ref: KeysetRef;
  readonly amount: number;
  readonly quoteId: string;
}): Effect.Effect<
  { proofs: Proof[]; recovered: boolean },
  CashuMintFailure | CounterStoreError,
  CounterStore
> =>
  Effect.gen(function* () {
    const { handle, ref, amount, quoteId } = args;
    const counters = yield* CounterStore;

    let pendingRetries = 0;
    let collisionRetries = 0;

    while (true) {
      const counter = effectiveCounter(yield* counters.getCounter(ref));
      const outcome = yield* Effect.either(
        runMintCall(handle.mintUrl, () =>
          handle.wallet.mintProofs(amount, quoteId, { counter }),
        ),
      );

      if (outcome._tag === "Right") {
        yield* counters.ensureCounterAtLeast(ref, counter + outcome.right.length);
        return { proofs: outcome.right, recovered: false };
      }

      const failure = outcome.left;

      if (isOutputsPendingFailure(failure) && pendingRetries < MAX_COLLISION_ATTEMPTS) {
        pendingRetries += 1;
        yield* counters.bumpCounter(ref, COLLISION_BUMP);
        continue;
      }

      if (!isOutputsAlreadySignedFailure(failure)) return yield* Effect.fail(failure);
      if (collisionRetries >= MAX_COLLISION_ATTEMPTS) return yield* Effect.fail(failure);
      collisionRetries += 1;

      const classified = yield* classifyAlreadySigned({ handle, amount, counter }).pipe(
        // If restore itself fails, surface the original mint failure (PoC).
        Effect.mapError(() => failure),
      );

      if (classified.kind === "recovery") {
        yield* counters.ensureCounterAtLeast(
          ref,
          classified.lastSigned !== null
            ? classified.lastSigned + 1
            : counter + classified.proofs.length,
        );
        return { proofs: classified.proofs, recovered: true };
      }

      if (classified.kind === "collision" && classified.lastSigned !== null) {
        yield* counters.ensureCounterAtLeast(ref, classified.lastSigned + 1);
      } else {
        yield* counters.bumpCounter(ref, COLLISION_BUMP);
      }
    }
  });
