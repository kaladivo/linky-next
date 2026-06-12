/**
 * Consolidation actions (issue #42; `mints.melt-to-main`): the impure half
 * over core's `meltToMainMint` + the #35 repositories, following the
 * topupActions conventions — plain async functions over the session store,
 * typed workflow errors mapped to plain outcome values, repository write
 * failures on app-controlled values thrown as defects.
 *
 * Flow per run (PoC `meltLargestForeignMintToMainMint` semantics):
 *
 * 1. pick the largest foreign-mint spendable balance (core policy);
 * 2. record a pending "cashu/swap" transaction; core's `onQuoteCreated`
 *    hook patches the claimable quote into `detailsJson` BEFORE each melt
 *    (crash between melt and claim never loses the quote);
 * 3. melt at the source mint with the PoC fee-retry ladder (core);
 * 4. on success: persist the NUT-08 remainder as a fresh accepted token at
 *    the SOURCE mint, mark the consumed source rows spent, then claim the
 *    target quote (`claimTopup`) and persist the claimed token;
 * 5. a claim that cannot complete yet leaves the row pending
 *    ("melted-awaiting-claim") — `resumePendingConsolidations` finishes it
 *    on a later trigger (any device holding the seed can).
 */
import type { CashuSeed, MeltToMainResult } from "@linky/core";
import {
  TokenStateTransition,
  canonicalizeMintUrl,
  claimTopup,
  meltToMainMint,
  mintDisplayName,
  selectConsolidationSource,
} from "@linky/core";
import type { LinkyStore, TokensRepository, TransactionRecord } from "@linky/evolu-store";
import {
  createMintsRepository,
  createTokensRepository,
  createTransactionsRepository,
} from "@linky/evolu-store";
import { Effect, Option } from "effect";

import { environment } from "../environment";
import { runCashuEffect } from "../runtime";
import { getReadyLinkyStore, invalidateStoreData } from "../store/storeManager";
import type { PendingConsolidationClaim } from "./consolidationModel";
import {
  CONSOLIDATION_PHASE,
  CONSOLIDATION_TRANSACTION_CATEGORY,
  CONSOLIDATION_TRANSACTION_METHOD,
  isPendingConsolidationStale,
  parsePendingConsolidationClaim,
  serializePendingConsolidationClaim,
} from "./consolidationModel";

/** How many newest history rows are scanned for pending consolidations. */
const PENDING_SCAN_LIMIT = 100;

/** Inline claim attempts right after the melt (then background resume). */
const INLINE_CLAIM_ATTEMPTS = 3;
const INLINE_CLAIM_RETRY_DELAY_MS = 1500;

const sleep = (millis: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, millis));

// ---------------------------------------------------------------------------
// Availability (token list / mint settings entry points)
// ---------------------------------------------------------------------------

export interface MeltToMainAvailability {
  readonly sourceMintUrl: string;
  readonly sourceDisplayName: string;
  readonly sourceSpendableSat: number;
  readonly targetMintUrl: string;
  readonly targetDisplayName: string;
  /** Accepted records funding the move (the autoswap signature input). */
  readonly sourceRecordCount: number;
}

/** The effective main mint: synced preference or the env default. */
export const resolveMainMintUrl = async (store: LinkyStore): Promise<string> => {
  const preferred = await createMintsRepository(store).getMainMintUrl();
  return canonicalizeMintUrl(preferred ?? environment.cashuMintUrl);
};

const acceptedSourceRecords = async (tokens: TokensRepository, sourceMintUrl: string) => {
  const records = await tokens.list({ states: ["accepted"], mintUrl: sourceMintUrl });
  return records.filter((record) => record.unit === "sat" && record.token.trim() !== "");
};

/**
 * Whether (and what) melt-to-main would move right now — drives the token
 * list button and the autoswap trigger. Null when no foreign mint holds
 * spendable sat.
 */
export const loadMeltToMainAvailability = async (
  store: LinkyStore,
): Promise<MeltToMainAvailability | null> => {
  const tokens = createTokensRepository(store);
  const targetMintUrl = await resolveMainMintUrl(store);
  const balances = await tokens.balances();
  const source = selectConsolidationSource(balances, targetMintUrl);
  if (source === null) return null;
  const records = await acceptedSourceRecords(tokens, source.mintUrl);
  if (records.length === 0) return null;
  return {
    sourceMintUrl: source.mintUrl,
    sourceDisplayName: mintDisplayName(source.mintUrl),
    sourceSpendableSat: source.spendableSat,
    targetMintUrl,
    targetDisplayName: mintDisplayName(targetMintUrl),
    sourceRecordCount: records.length,
  };
};

// ---------------------------------------------------------------------------
// Melt-to-main
// ---------------------------------------------------------------------------

export type ConsolidateOutcome =
  /** No foreign-mint balance to move. */
  | { readonly kind: "nothing" }
  /** Value arrived at the main mint (and any remainder stayed put). */
  | {
      readonly kind: "consolidated";
      readonly amountSat: number;
      readonly remainderSat: number;
      readonly targetMintUrl: string;
    }
  /** Melt done; the claim completes in the background. */
  | { readonly kind: "pending-claim"; readonly amountSat: number }
  | { readonly kind: "failed"; readonly reason: string };

/** Inserts a token unless the exact encoded token is already stored. */
const insertTokenDeduped = (
  tokens: TokensRepository,
  known: ReadonlyArray<{ readonly token: string }>,
  row: { mintUrl: string; unit: string; amount: number; token: string },
): void => {
  if (known.some((record) => record.token === row.token)) return;
  const inserted = tokens.insert({ ...row, state: "accepted" });
  if (!inserted.ok) throw new Error(`store consolidated token failed: ${inserted.error._tag}`);
};

/**
 * Claims a consolidation's target quote and finalizes its transaction row.
 * Returns false when the quote is not claimable yet (row stays pending).
 */
const claimConsolidation = async (
  store: LinkyStore,
  seed: CashuSeed,
  transactionId: string,
  claim: PendingConsolidationClaim,
): Promise<boolean> => {
  const transactions = createTransactionsRepository(store);
  const claimed = await runCashuEffect(
    store,
    claimTopup({
      seed,
      mintUrl: claim.quote.mintUrl,
      quoteId: claim.quote.quoteId,
      amount: claim.quote.amountSat,
      unit: claim.quote.unit,
    }).pipe(
      Effect.map((result) => ({ ok: true, result }) as const),
      Effect.catchTag("MintQuoteNotClaimableError", (error) =>
        Effect.succeed({ ok: false, state: error.state } as const),
      ),
      Effect.catchAll((error) =>
        Effect.succeed({ ok: false, state: null, errorTag: error._tag } as const),
      ),
    ),
  );

  if (!claimed.ok) {
    if (claimed.state === "EXPIRED") {
      transactions.update(transactionId, {
        status: "failed",
        phase: CONSOLIDATION_PHASE.expired,
        error: "quote expired",
      });
      invalidateStoreData();
    }
    return false;
  }

  const tokens = createTokensRepository(store);
  const known = await tokens.list({ mintUrl: claimed.result.mintUrl });
  insertTokenDeduped(tokens, known, {
    mintUrl: claimed.result.mintUrl,
    unit: claimed.result.unit,
    amount: claimed.result.amount,
    token: claimed.result.token,
  });
  transactions.update(transactionId, {
    status: "completed",
    phase: CONSOLIDATION_PHASE.claimed,
    amount: claimed.result.amount,
  });
  invalidateStoreData();
  return true;
};

/**
 * `mints.melt-to-main`: move the largest foreign-mint balance to the main
 * mint, fee-retrying lower amounts as needed, keeping the new balance and
 * any remainder. Used by the token-list button and the autoswap runner.
 */
export const meltLargestToMain = async (
  store: LinkyStore,
  seed: CashuSeed,
): Promise<ConsolidateOutcome> => {
  const availability = await loadMeltToMainAvailability(store);
  if (availability === null) return { kind: "nothing" };

  const tokens = createTokensRepository(store);
  const transactions = createTransactionsRepository(store);
  const mints = createMintsRepository(store);
  const ensured = await mints.ensure(availability.targetMintUrl);
  if (!ensured.ok) throw new Error(`ensure mint failed: ${ensured.error._tag}`);

  const sourceRecords = await acceptedSourceRecords(tokens, availability.sourceMintUrl);
  if (sourceRecords.length === 0) return { kind: "nothing" };

  const nowMs = Date.now();
  const recorded = transactions.record({
    happenedAtSec: Math.max(1, Math.floor(nowMs / 1000)),
    direction: "in",
    status: "pending",
    category: CONSOLIDATION_TRANSACTION_CATEGORY,
    method: CONSOLIDATION_TRANSACTION_METHOD,
    phase: CONSOLIDATION_PHASE.consolidating,
    amount: availability.sourceSpendableSat,
    unit: "sat",
    mintUrl: availability.targetMintUrl,
  });
  if (!recorded.ok) throw new Error(`record consolidation failed: ${recorded.error._tag}`);
  const transactionId = recorded.value.id;

  let lastClaim: PendingConsolidationClaim | null = null;
  const melted = await runCashuEffect(
    store,
    meltToMainMint({
      seed,
      sourceMintUrl: availability.sourceMintUrl,
      targetMintUrl: availability.targetMintUrl,
      tokens: sourceRecords.map((record) => record.token),
      unit: "sat",
      // Persist the claimable quote BEFORE the melt runs (crash safety).
      onQuoteCreated: (quote) => {
        lastClaim = {
          sourceMintUrl: availability.sourceMintUrl,
          quote: {
            mintUrl: availability.targetMintUrl,
            unit: "sat",
            amountSat: quote.amountSat,
            quoteId: quote.quoteId,
            invoice: quote.invoice,
            expiresAtSec: quote.expiresAtSec,
            createdAtMs: Date.now(),
          },
        };
        transactions.update(transactionId, {
          phase: CONSOLIDATION_PHASE.melting,
          amount: quote.amountSat,
          detailsJson: serializePendingConsolidationClaim(lastClaim),
        });
      },
    }).pipe(
      Effect.map((result) => ({ ok: true, result }) as const),
      Effect.catchAll((error) =>
        Effect.succeed({
          ok: false,
          errorTag: error._tag,
          reason:
            error._tag === "ConsolidationExhaustedError"
              ? error.lastError
              : error._tag === "MintProtocolError"
                ? error.detail
                : error._tag,
        } as const),
      ),
    ),
  );

  if (!melted.ok) {
    transactions.update(transactionId, {
      status: "failed",
      phase: CONSOLIDATION_PHASE.failed,
      error: melted.reason.slice(0, 500),
    });
    invalidateStoreData();
    return { kind: "failed", reason: melted.reason };
  }

  const result: MeltToMainResult = melted.result;

  // Remainder first (it is live value), then retire the consumed sources.
  const changeToken = Option.getOrNull(result.changeToken);
  if (changeToken !== null && result.changeAmount > 0) {
    const known = await tokens.list({ mintUrl: result.sourceMintUrl });
    insertTokenDeduped(tokens, known, {
      mintUrl: result.sourceMintUrl,
      unit: result.unit,
      amount: result.changeAmount,
      token: changeToken,
    });
  }
  for (const record of sourceRecords) {
    // The melt consumed these proofs; storage-level MarkSpent mirrors what
    // a NUT-07 reconcile would discover.
    await tokens.transition(record.id, TokenStateTransition.MarkSpent(), Date.now());
  }
  transactions.update(transactionId, {
    phase: CONSOLIDATION_PHASE.awaitingClaim,
    amount: result.amountSat,
    feeAmount: result.feePaid,
  });
  invalidateStoreData();

  const claim: PendingConsolidationClaim = lastClaim ?? {
    sourceMintUrl: result.sourceMintUrl,
    quote: {
      mintUrl: result.targetMintUrl,
      unit: result.unit,
      amountSat: result.amountSat,
      quoteId: result.quoteId,
      invoice: result.invoice,
      expiresAtSec: result.expiresAtSec,
      createdAtMs: Date.now(),
    },
  };

  for (let attempt = 0; attempt < INLINE_CLAIM_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(INLINE_CLAIM_RETRY_DELAY_MS);
    if (await claimConsolidation(store, seed, transactionId, claim)) {
      return {
        kind: "consolidated",
        amountSat: result.amountSat,
        remainderSat: result.changeAmount,
        targetMintUrl: result.targetMintUrl,
      };
    }
  }
  return { kind: "pending-claim", amountSat: result.amountSat };
};

// ---------------------------------------------------------------------------
// Background resume (crash / not-yet-claimable recovery)
// ---------------------------------------------------------------------------

const isPendingConsolidationRow = (row: TransactionRecord): boolean =>
  row.status === "pending" &&
  row.category === CONSOLIDATION_TRANSACTION_CATEGORY &&
  row.method === CONSOLIDATION_TRANSACTION_METHOD;

/**
 * Finishes melted-but-unclaimed consolidations (PoC background claim tick):
 * stale quotes are marked failed; claimable ones are claimed and completed.
 * Returns the number of claims that completed.
 */
export const resumePendingConsolidations = async (
  store: LinkyStore,
  seed: CashuSeed,
): Promise<number> => {
  const transactions = createTransactionsRepository(store);
  const page = await transactions.listPage({ limit: PENDING_SCAN_LIMIT });
  const nowMs = Date.now();
  let claimed = 0;
  for (const row of page.items) {
    if (!isPendingConsolidationRow(row)) continue;
    const claim = parsePendingConsolidationClaim(row.detailsJson);
    if (claim === null) {
      // Pre-quote rows (crash before any melt attempt): nothing claimable.
      transactions.update(row.id, {
        status: "failed",
        phase: CONSOLIDATION_PHASE.failed,
        error: "interrupted before melt",
      });
      invalidateStoreData();
      continue;
    }
    if (isPendingConsolidationStale(claim, nowMs)) {
      transactions.update(row.id, {
        status: "failed",
        phase: CONSOLIDATION_PHASE.expired,
        error: "quote expired",
      });
      invalidateStoreData();
      continue;
    }
    if (await claimConsolidation(store, seed, row.id, claim)) claimed += 1;
  }
  return claimed;
};

/** Convenience wrapper for screens: session store + melt in one call. */
export const meltLargestToMainFromScreens = async (
  seed: CashuSeed,
): Promise<ConsolidateOutcome> => {
  const store = await getReadyLinkyStore();
  await resumePendingConsolidations(store, seed);
  return meltLargestToMain(store, seed);
};

/** useEffectQuery seam for the token-list button (walletData pattern). */
export const loadMeltToMainAvailabilityData: Effect.Effect<MeltToMainAvailability | null> =
  Effect.promise(async () => {
    const store = await getReadyLinkyStore();
    return loadMeltToMainAvailability(store);
  });
