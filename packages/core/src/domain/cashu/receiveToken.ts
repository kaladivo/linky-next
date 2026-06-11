/**
 * Receive (accept) a Cashu token — `cashu.accept-token` in the feature map.
 *
 * Semantics ported from the PoC (`cashuAccept.ts`): swap the token's proofs
 * at its mint for fresh deterministic proofs, under the per-keyset counter
 * lock. The deterministic retry ladder on output collisions:
 *
 * - OutputsAlreadySigned (11005): ask the mint via NUT-09 restore where the
 *   last signed slot in the window is and jump the counter precisely past
 *   it; if restore fails, fall back to a fixed +64 bump.
 * - OutputsArePending (11004): fixed +64 bump (restore cannot surface
 *   unsigned promises).
 * - at most 5 attempts, then the last mint failure surfaces.
 *
 * On success the counter advances by exactly the number of received proofs.
 */
import type { Proof } from "@cashu/cashu-ts";
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
import { isOutputsAlreadySignedFailure, isRecoverableOutputCollision } from "./errors.js";
import {
  COLLISION_BUMP,
  MAX_COLLISION_ATTEMPTS,
  decodeTokenForMint,
  effectiveCounter,
  keysetRefOf,
} from "./internal/deterministic.js";
import { loadWallet, runMintCall } from "./internal/wallet.js";
import type { CashuProof } from "./tokenCodec.js";
import { encodeCashuToken, parseCashuToken, sumProofAmounts } from "./tokenCodec.js";

export interface ReceiveTokenArgs {
  readonly seed: CashuSeed;
  readonly token: string;
}

export interface ReceiveTokenResult {
  readonly mintUrl: string;
  readonly unit: string;
  readonly amount: number;
  readonly proofs: ReadonlyArray<CashuProof>;
  /** The accepted token, re-encoded over the fresh proofs (memo preserved). */
  readonly token: string;
}

export type ReceiveTokenError =
  | InvalidCashuTokenError
  | WrongMintError
  | KeysetUnavailableError
  | CashuMintFailure
  | CounterStoreError;

export const receiveToken = (
  args: ReceiveTokenArgs,
): Effect.Effect<ReceiveTokenResult, ReceiveTokenError, HttpClient.HttpClient | CounterStore> =>
  Effect.gen(function* () {
    const parsed = yield* parseCashuToken(args.token);
    const counters = yield* CounterStore;

    const handle = yield* loadWallet({
      mintUrl: parsed.mintUrl,
      unit: parsed.unit,
      seed: args.seed,
    });
    const decoded = yield* decodeTokenForMint(handle, args.token);
    const ref = keysetRefOf(handle);

    const receiveAttempts: Effect.Effect<Proof[], ReceiveTokenError> = Effect.gen(function* () {
      let lastFailure: CashuMintFailure | null = null;

      for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt += 1) {
        const counter = effectiveCounter(yield* counters.getCounter(ref));
        const outcome = yield* Effect.either(
          runMintCall(handle.mintUrl, () => handle.wallet.receive(decoded, { counter })),
        );
        if (outcome._tag === "Right") {
          yield* counters.ensureCounterAtLeast(ref, counter + outcome.right.length);
          return outcome.right;
        }

        const failure = outcome.left;
        if (!isRecoverableOutputCollision(failure)) return yield* Effect.fail(failure);
        lastFailure = failure;

        if (isOutputsAlreadySignedFailure(failure)) {
          // Measure the colliding range via NUT-09 restore; jump past it.
          const lastSigned = yield* runMintCall(handle.mintUrl, () =>
            handle.wallet.restore(counter, 100, { keysetId: handle.keysetId }),
          ).pipe(
            Effect.map((restored) =>
              typeof restored.lastCounterWithSignature === "number" &&
              Number.isFinite(restored.lastCounterWithSignature)
                ? Option.some(restored.lastCounterWithSignature)
                : Option.none<number>(),
            ),
            Effect.orElseSucceed(() => Option.none<number>()),
          );
          if (Option.isSome(lastSigned)) {
            yield* counters.ensureCounterAtLeast(ref, lastSigned.value + 1);
          } else {
            yield* counters.bumpCounter(ref, COLLISION_BUMP);
          }
        } else {
          yield* counters.bumpCounter(ref, COLLISION_BUMP);
        }
      }

      // Collision retries exhausted — surface the last mint failure (PoC).
      if (lastFailure === null) {
        return yield* Effect.die(new Error("unreachable: collision loop without failure"));
      }
      return yield* Effect.fail(lastFailure);
    });

    const proofs = yield* counters.withCounterLock(ref, receiveAttempts);

    const amount = sumProofAmounts(proofs);
    const token = yield* encodeCashuToken({
      mintUrl: handle.mintUrl,
      proofs,
      unit: handle.unit,
      ...(Option.isSome(parsed.memo) ? { memo: parsed.memo.value } : {}),
    });

    return { mintUrl: handle.mintUrl, unit: handle.unit, amount, proofs, token };
  });
