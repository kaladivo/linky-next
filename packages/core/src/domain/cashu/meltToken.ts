/**
 * Melt — pay a Lightning invoice from stored proofs (NUT-05/NUT-08).
 * Ported from the PoC (`cashuMelt.ts`):
 *
 * - one payment never splits across mints: all funding tokens are decoded
 *   against the single target mint (WrongMintError otherwise);
 * - the proofs are handed to `meltProofs` as-is (sum must cover
 *   `amount + fee_reserve + input fees`); the mint returns overpaid fees as
 *   NUT-08 blinded change, preserving remainder value;
 * - counter discipline: collisions bump +64 and retry (max 5); success
 *   bumps by `max(blankOutputCount(feeReserve), change.length)` — ALL blank
 *   outputs consume counter slots and persist at the mint even when the
 *   mint signs fewer change outputs (or none).
 */
import type { MeltProofsResponse } from "@cashu/cashu-ts";
import { Effect, Option } from "effect";

import type { CounterStoreError } from "../../ports/CounterStore.js";
import { CounterStore } from "../../ports/CounterStore.js";
import type { HttpClient } from "../../ports/index.js";
import type { CashuSeed } from "../identity/DerivedIdentities.js";
import type {
  CashuMintFailure,
  InvalidCashuTokenError,
  KeysetUnavailableError,
  WrongMintError,
} from "./errors.js";
import { InsufficientFundsError, isRecoverableOutputCollision } from "./errors.js";
import {
  COLLISION_BUMP,
  MAX_COLLISION_ATTEMPTS,
  computeNumberOfBlankOutputs,
  decodeTokenForMint,
  effectiveCounter,
  keysetRefOf,
} from "./internal/deterministic.js";
import { loadWallet, runMintCall } from "./internal/wallet.js";
import { dedupeProofs, filterUnspentProofs } from "./proofStates.js";
import type { CashuProof } from "./tokenCodec.js";
import { encodeCashuToken, sumProofAmounts } from "./tokenCodec.js";

export interface PayInvoiceArgs {
  readonly seed: CashuSeed;
  readonly mintUrl: string;
  /** BOLT11 invoice to pay. */
  readonly invoice: string;
  /** Stored token strings to fund the payment — all at `mintUrl`. */
  readonly tokens: ReadonlyArray<string>;
  readonly unit?: string | undefined;
}

export interface PayInvoiceResult {
  readonly mintUrl: string;
  readonly unit: string;
  readonly quoteId: string;
  /** Invoice amount paid (quote.amount). */
  readonly paidAmount: number;
  readonly feeReserve: number;
  /** Actual LN fee the mint reported, when it reports one (else 0). */
  readonly feePaid: number;
  readonly paymentPreimage: Option.Option<string>;
  /** NUT-08 change — the preserved remainder value. */
  readonly changeAmount: number;
  readonly changeProofs: ReadonlyArray<CashuProof>;
  readonly changeToken: Option.Option<string>;
}

export type PayInvoiceError =
  | InvalidCashuTokenError
  | WrongMintError
  | KeysetUnavailableError
  | InsufficientFundsError
  | CashuMintFailure
  | CounterStoreError;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Mint-reported actual fee, when present (PoC reads fee_paid/feePaid/fee). */
const readFeePaid = (melt: MeltProofsResponse): number => {
  for (const source of [melt as unknown, melt.quote as unknown]) {
    if (!isRecord(source)) continue;
    for (const field of ["fee_paid", "feePaid", "fee"]) {
      const raw = source[field];
      const value = Number(raw);
      if (raw !== undefined && Number.isFinite(value) && value > 0) return Math.trunc(value);
    }
  }
  return 0;
};

export const payInvoice = (
  args: PayInvoiceArgs,
): Effect.Effect<PayInvoiceResult, PayInvoiceError, HttpClient.HttpClient | CounterStore> =>
  Effect.gen(function* () {
    const counters = yield* CounterStore;
    const handle = yield* loadWallet({ mintUrl: args.mintUrl, unit: args.unit, seed: args.seed });
    const ref = keysetRefOf(handle);

    const allProofs: CashuProof[] = [];
    for (const tokenText of args.tokens) {
      const decoded = yield* decodeTokenForMint(handle, tokenText);
      allProofs.push(...decoded.proofs);
    }

    const deduped = dedupeProofs(allProofs);
    const spendable = yield* runMintCall(handle.mintUrl, () =>
      handle.wallet.checkProofsStates(deduped),
    ).pipe(
      Effect.map((states) => filterUnspentProofs(deduped, states)),
      Effect.orElseSucceed(() => deduped),
    );

    const quote = yield* runMintCall(handle.mintUrl, () =>
      handle.wallet.createMeltQuote(args.invoice),
    );
    const paidAmount = quote.amount ?? 0;
    const feeReserve = quote.fee_reserve ?? 0;
    const inputFee = yield* runMintCall(handle.mintUrl, () =>
      Promise.resolve(handle.wallet.getFeesForProofs(spendable)),
    );
    const required = paidAmount + feeReserve + inputFee;
    const available = sumProofAmounts(spendable);
    if (available < required) {
      return yield* Effect.fail(
        new InsufficientFundsError({ mintUrl: handle.mintUrl, required, available }),
      );
    }

    const meltAttempts: Effect.Effect<MeltProofsResponse, PayInvoiceError> = Effect.gen(
      function* () {
        let lastFailure: CashuMintFailure | null = null;

        for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt += 1) {
          const counter = effectiveCounter(yield* counters.getCounter(ref));
          const outcome = yield* Effect.either(
            runMintCall(handle.mintUrl, () =>
              handle.wallet.meltProofs(quote, spendable, { counter }),
            ),
          );
          if (outcome._tag === "Right") {
            // Advance past the FULL blank-output range, not just the signed
            // change count — unsigned blanks still sit in the mint's
            // promises table and would collide with future derivations.
            const blankCount = computeNumberOfBlankOutputs(feeReserve);
            const changeCount = outcome.right.change.length;
            yield* counters.ensureCounterAtLeast(
              ref,
              counter + Math.max(blankCount, changeCount),
            );
            return outcome.right;
          }

          const failure = outcome.left;
          if (!isRecoverableOutputCollision(failure)) return yield* Effect.fail(failure);
          lastFailure = failure;
          yield* counters.bumpCounter(ref, COLLISION_BUMP);
        }

        if (lastFailure === null) {
          return yield* Effect.die(new Error("unreachable: collision loop without failure"));
        }
        return yield* Effect.fail(lastFailure);
      },
    );

    const melt = yield* counters.withCounterLock(ref, meltAttempts);

    const changeProofs = melt.change;
    const changeAmount = sumProofAmounts(changeProofs);
    const changeToken =
      changeProofs.length > 0
        ? Option.some(
            yield* encodeCashuToken({
              mintUrl: handle.mintUrl,
              proofs: changeProofs,
              unit: handle.unit,
            }),
          )
        : Option.none<string>();

    return {
      mintUrl: handle.mintUrl,
      unit: handle.unit,
      quoteId: quote.quote,
      paidAmount,
      feeReserve,
      feePaid: readFeePaid(melt),
      paymentPreimage: Option.fromNullable(melt.quote.payment_preimage).pipe(
        Option.filter((preimage) => preimage !== ""),
      ),
      changeAmount,
      changeProofs,
      changeToken,
    };
  });
