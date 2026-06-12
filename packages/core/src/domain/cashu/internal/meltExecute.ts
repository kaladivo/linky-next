/**
 * Shared NUT-05/NUT-08 melt execution under the deterministic-counter
 * discipline — used by `meltToken.ts` (pay an invoice from stored proofs)
 * and `../mints/meltToMain.ts` (cross-mint consolidation melt, issue #42).
 *
 * Counter contract (PoC `cashuMelt.ts`): collisions bump +64 and retry
 * (max 5); success advances the counter by `max(blankOutputCount(feeReserve),
 * change.length)` — ALL blank outputs consume counter slots and persist at
 * the mint even when it signs fewer change outputs (or none).
 */
import type { MeltProofsResponse, MeltQuoteResponse, Proof } from "@cashu/cashu-ts";
import { Effect } from "effect";

import type { CounterStoreError } from "../../../ports/CounterStore.js";
import { CounterStore } from "../../../ports/CounterStore.js";
import type { CashuMintFailure } from "../errors.js";
import { isRecoverableOutputCollision } from "../errors.js";
import {
  COLLISION_BUMP,
  MAX_COLLISION_ATTEMPTS,
  computeNumberOfBlankOutputs,
  effectiveCounter,
  keysetRefOf,
} from "./deterministic.js";
import type { WalletHandle } from "./wallet.js";
import { runMintCall } from "./wallet.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Mint-reported actual fee, when present (PoC reads fee_paid/feePaid/fee). */
export const readFeePaid = (melt: MeltProofsResponse): number => {
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

/**
 * Runs `meltProofs` for one quote under the per-keyset counter lock with
 * the full collision/blank-output discipline. The proofs must already be
 * the state-checked spendable set covering `amount + fee_reserve + input
 * fees` — this function performs no funding checks.
 */
export const executeMeltWithCounters = (args: {
  readonly handle: WalletHandle;
  readonly quote: MeltQuoteResponse;
  readonly proofs: ReadonlyArray<Proof>;
}): Effect.Effect<MeltProofsResponse, CashuMintFailure | CounterStoreError, CounterStore> =>
  Effect.gen(function* () {
    const { handle, quote } = args;
    const proofs = [...args.proofs];
    const counters = yield* CounterStore;
    const ref = keysetRefOf(handle);
    const feeReserve = quote.fee_reserve ?? 0;

    const meltAttempts: Effect.Effect<
      MeltProofsResponse,
      CashuMintFailure | CounterStoreError,
      never
    > = Effect.gen(function* () {
      let lastFailure: CashuMintFailure | null = null;

      for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt += 1) {
        const counter = effectiveCounter(yield* counters.getCounter(ref));
        const outcome = yield* Effect.either(
          runMintCall(handle.mintUrl, () => handle.wallet.meltProofs(quote, proofs, { counter })),
        );
        if (outcome._tag === "Right") {
          // Advance past the FULL blank-output range, not just the signed
          // change count — unsigned blanks still sit in the mint's
          // promises table and would collide with future derivations.
          const blankCount = computeNumberOfBlankOutputs(feeReserve);
          const changeCount = outcome.right.change.length;
          yield* counters.ensureCounterAtLeast(ref, counter + Math.max(blankCount, changeCount));
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
    });

    return yield* counters.withCounterLock(ref, meltAttempts);
  });
