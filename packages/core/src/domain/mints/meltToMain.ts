/**
 * Cross-mint melt-to-main (issue #42; `mints.melt-to-main`) — move value
 * from a foreign mint to the main mint by melting the foreign proofs into a
 * Lightning payment of a mint quote at the main mint (the PoC's
 * `meltLargestForeignMintToMainMint` core, minus storage):
 *
 * 1. decode + state-check the source tokens → the spendable funding set;
 * 2. pre-flight fee probe: quote the full balance at the target, ask the
 *    source mint for its melt fee_reserve, and size the first attempt to
 *    `balance - fee_reserve - input_fee` (instead of burning the whole
 *    retry ladder on Insufficient);
 * 3. per attempt: fresh target mint quote → source melt quote → funding
 *    check → NUT-05/NUT-08 melt under the counter discipline;
 * 4. on a retryable amount failure, extend the queue via the PoC ladder
 *    (exact reported shortage first), pause 800ms (mint quote endpoints
 *    rate-limit hard), and retry a lower amount — at most 8 attempts;
 * 5. on success, return the paid target quote (the caller claims it with
 *    `claimTopup` and persists rows) plus the NUT-08 change token — the
 *    remainder stays as value at the SOURCE mint.
 *
 * One payment never splits across mints: every funding token must belong
 * to the source mint (`WrongMintError` otherwise).
 *
 * Persistence is the caller's: this module never sees repositories. The
 * `onQuoteCreated` hook fires BEFORE each melt so the caller can persist
 * the claimable quote first — a crash between melt and claim then loses no
 * funds (the quote id survives; NUT-08 change is restorable via NUT-09).
 */
import { Duration, Effect, Option } from "effect";

import type { CounterStoreError } from "../../ports/CounterStore.js";
import type { CounterStore } from "../../ports/CounterStore.js";
import type { HttpClient } from "../../ports/index.js";
import type { CashuSeed } from "../identity/DerivedIdentities.js";
import type {
  CashuMintFailure,
  InvalidCashuTokenError,
  KeysetUnavailableError,
  WrongMintError,
} from "../cashu/errors.js";
import { InsufficientFundsError } from "../cashu/errors.js";
import { decodeTokenForMint } from "../cashu/internal/deterministic.js";
import { executeMeltWithCounters, readFeePaid } from "../cashu/internal/meltExecute.js";
import type { WalletHandle } from "../cashu/internal/wallet.js";
import { loadWallet, runMintCall } from "../cashu/internal/wallet.js";
import { dedupeProofs, filterUnspentProofs } from "../cashu/proofStates.js";
import type { CashuProof } from "../cashu/tokenCodec.js";
import { encodeCashuToken, sumProofAmounts } from "../cashu/tokenCodec.js";
import {
  CONSOLIDATION_MAX_AMOUNT_ATTEMPTS,
  CONSOLIDATION_RETRY_DELAY_MILLIS,
  applyConsolidationSizing,
  buildPaymentAmountAttempts,
  buildPaymentFailureAmountAttempts,
  isRetryablePaymentAmountFailure,
  sizeConsolidationFirstAttempt,
} from "./consolidation.js";
import { ConsolidationExhaustedError, ConsolidationUnavailableError } from "./errors.js";

/** A target-mint quote one melt attempt will pay (persist BEFORE the melt). */
export interface MeltToMainQuote {
  readonly quoteId: string;
  /** BOLT11 invoice at the target mint the source melt pays. */
  readonly invoice: string;
  readonly amountSat: number;
  /** Mint-reported expiry, unix seconds; 0 = unknown. */
  readonly expiresAtSec: number;
}

export interface MeltToMainArgs {
  readonly seed: CashuSeed;
  readonly sourceMintUrl: string;
  readonly targetMintUrl: string;
  /** Stored token strings funding the move — all at `sourceMintUrl`. */
  readonly tokens: ReadonlyArray<string>;
  readonly unit?: string | undefined;
  /** Pause between amount attempts; default the PoC's 800ms. Tests pass 0. */
  readonly retryDelayMillis?: number | undefined;
  /** Fires before each melt attempt with the quote it will pay. */
  readonly onQuoteCreated?: ((quote: MeltToMainQuote) => void) | undefined;
}

export interface MeltToMainResult {
  readonly sourceMintUrl: string;
  readonly targetMintUrl: string;
  readonly unit: string;
  /** Value now claimable at the target mint (the paid quote's amount). */
  readonly amountSat: number;
  readonly quoteId: string;
  readonly invoice: string;
  readonly expiresAtSec: number;
  readonly feeReserve: number;
  /** Actual LN fee the source mint reported (0 when it reports none). */
  readonly feePaid: number;
  /** NUT-08 change — the preserved remainder at the SOURCE mint. */
  readonly changeAmount: number;
  readonly changeToken: Option.Option<string>;
  /** Amount attempts consumed (1 = first attempt succeeded). */
  readonly attempts: number;
}

export type MeltToMainError =
  | ConsolidationUnavailableError
  | ConsolidationExhaustedError
  | InvalidCashuTokenError
  | WrongMintError
  | KeysetUnavailableError
  | InsufficientFundsError
  | CashuMintFailure
  | CounterStoreError;

/**
 * The PoC retryability test works over message strings; map our typed
 * failures to the strings it knows. `InsufficientFundsError` deliberately
 * renders as the PoC's own wording so the `need X, have Y` shortage parse
 * applies (`consolidation.golden.json` pins that parse).
 */
const failureMessage = (error: MeltToMainError): string => {
  switch (error._tag) {
    case "InsufficientFundsError":
      return `Insufficient funds (need ${String(error.required)}, have ${String(error.available)})`;
    case "MintProtocolError":
      return error.detail;
    case "MintConnectionError":
    case "WalletOperationError":
      return error.reason;
    default:
      return error._tag;
  }
};

interface AttemptContext {
  readonly source: WalletHandle;
  readonly target: WalletHandle;
  readonly spendable: ReadonlyArray<CashuProof>;
  readonly sourceBalance: number;
  readonly onQuoteCreated: ((quote: MeltToMainQuote) => void) | undefined;
}

const attemptOnce = (
  ctx: AttemptContext,
  amountSat: number,
  attempts: number,
): Effect.Effect<MeltToMainResult, MeltToMainError, CounterStore> =>
  Effect.gen(function* () {
    const { source, target, spendable, sourceBalance } = ctx;

    const mintQuote = yield* runMintCall(target.mintUrl, () =>
      target.wallet.createMintQuote(amountSat),
    );
    const expiresAtSec = Number.isFinite(mintQuote.expiry) ? Math.trunc(mintQuote.expiry) : 0;
    ctx.onQuoteCreated?.({
      quoteId: mintQuote.quote,
      invoice: mintQuote.request,
      amountSat,
      expiresAtSec,
    });

    const meltQuote = yield* runMintCall(source.mintUrl, () =>
      source.wallet.createMeltQuote(mintQuote.request),
    );
    const paidAmount = meltQuote.amount ?? 0;
    const feeReserve = meltQuote.fee_reserve ?? 0;
    const inputFee = yield* runMintCall(source.mintUrl, () =>
      Promise.resolve(source.wallet.getFeesForProofs([...spendable])),
    );
    const required = paidAmount + feeReserve + inputFee;
    if (sourceBalance < required) {
      return yield* Effect.fail(
        new InsufficientFundsError({
          mintUrl: source.mintUrl,
          required,
          available: sourceBalance,
        }),
      );
    }

    const melt = yield* executeMeltWithCounters({
      handle: source,
      quote: meltQuote,
      proofs: [...spendable],
    });

    const changeProofs = melt.change;
    const changeAmount = sumProofAmounts(changeProofs);
    const changeToken =
      changeProofs.length > 0
        ? Option.some(
            yield* encodeCashuToken({
              mintUrl: source.mintUrl,
              proofs: changeProofs,
              unit: source.unit,
            }),
          )
        : Option.none<string>();

    return {
      sourceMintUrl: source.mintUrl,
      targetMintUrl: target.mintUrl,
      unit: target.unit,
      amountSat,
      quoteId: mintQuote.quote,
      invoice: mintQuote.request,
      expiresAtSec,
      feeReserve,
      feePaid: readFeePaid(melt),
      changeAmount,
      changeToken,
      attempts,
    };
  });

export const meltToMainMint = (
  args: MeltToMainArgs,
): Effect.Effect<MeltToMainResult, MeltToMainError, HttpClient.HttpClient | CounterStore> =>
  Effect.gen(function* () {
    const unit = args.unit ?? "sat";
    const source = yield* loadWallet({ mintUrl: args.sourceMintUrl, unit, seed: args.seed });
    const target = yield* loadWallet({ mintUrl: args.targetMintUrl, unit, seed: args.seed });

    // Funding set: decode against the source mint, dedupe, drop spent.
    const allProofs: CashuProof[] = [];
    for (const tokenText of args.tokens) {
      const decoded = yield* decodeTokenForMint(source, tokenText);
      allProofs.push(...decoded.proofs);
    }
    const deduped = dedupeProofs(allProofs);
    const spendable = yield* runMintCall(source.mintUrl, () =>
      source.wallet.checkProofsStates(deduped),
    ).pipe(
      Effect.map((states) => filterUnspentProofs(deduped, states)),
      Effect.orElseSucceed(() => deduped),
    );
    const sourceBalance = sumProofAmounts(spendable);
    if (sourceBalance <= 0) {
      return yield* Effect.fail(
        new ConsolidationUnavailableError({ sourceMintUrl: source.mintUrl }),
      );
    }

    // Full-balance ladder, capped (PoC MAX_AMOUNT_ATTEMPTS).
    let queue = buildPaymentAmountAttempts(sourceBalance, sourceBalance).slice(
      0,
      CONSOLIDATION_MAX_AMOUNT_ATTEMPTS,
    );
    const seen = new Set(queue);

    // Pre-flight fee probe (best effort — a probe failure keeps the ladder).
    const probe = yield* Effect.either(
      Effect.gen(function* () {
        const probeQuote = yield* runMintCall(target.mintUrl, () =>
          target.wallet.createMintQuote(sourceBalance),
        );
        const probeMeltQuote = yield* runMintCall(source.mintUrl, () =>
          source.wallet.createMeltQuote(probeQuote.request),
        );
        const probeInputFee = yield* runMintCall(source.mintUrl, () =>
          Promise.resolve(source.wallet.getFeesForProofs([...spendable])),
        );
        return {
          feeReserve: Number(probeMeltQuote.fee_reserve ?? 0) || 0,
          inputFee: Number(probeInputFee ?? 0) || 0,
        };
      }),
    );
    if (probe._tag === "Right") {
      const sized = sizeConsolidationFirstAttempt(
        sourceBalance,
        probe.right.feeReserve,
        probe.right.inputFee,
      );
      if (sized !== null) {
        queue = applyConsolidationSizing(queue, sized);
        seen.clear();
        for (const candidate of queue) seen.add(candidate);
      }
    }

    const ctx: AttemptContext = {
      source,
      target,
      spendable,
      sourceBalance,
      onQuoteCreated: args.onQuoteCreated,
    };
    const retryDelayMillis = args.retryDelayMillis ?? CONSOLIDATION_RETRY_DELAY_MILLIS;
    let lastError = "melt failed";

    for (let index = 0; index < queue.length; index += 1) {
      const amountSat = queue[index]!;
      const outcome = yield* Effect.either(attemptOnce(ctx, amountSat, index + 1));
      if (outcome._tag === "Right") return outcome.right;

      const message = failureMessage(outcome.left);
      if (!isRetryablePaymentAmountFailure(message)) {
        return yield* Effect.fail(outcome.left);
      }
      lastError = message;

      // Prefer stepping by the exact reported shortage, then the ladder.
      if (queue.length < CONSOLIDATION_MAX_AMOUNT_ATTEMPTS) {
        for (const retryAmount of buildPaymentFailureAmountAttempts(amountSat, message)) {
          if (seen.has(retryAmount)) continue;
          seen.add(retryAmount);
          queue.push(retryAmount);
          if (queue.length >= CONSOLIDATION_MAX_AMOUNT_ATTEMPTS) break;
        }
      }

      if (index + 1 < queue.length && retryDelayMillis > 0) {
        yield* Effect.sleep(Duration.millis(retryDelayMillis));
      }
    }

    return yield* Effect.fail(
      new ConsolidationExhaustedError({
        sourceMintUrl: source.mintUrl,
        targetMintUrl: target.mintUrl,
        attempts: queue.length,
        lastError,
      }),
    );
  });
