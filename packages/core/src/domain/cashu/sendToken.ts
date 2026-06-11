/**
 * Emit an outgoing token for an amount — `cashu.emit-token` in the feature
 * map. Ported from the PoC (`cashuSend.ts`): decode the caller's stored
 * tokens (all at ONE mint, structurally enforced), drop already-spent
 * proofs, swap into exact send + keep sets with deterministic outputs.
 *
 * Counter discipline: collisions bump +64 and retry (max 5); success bumps
 * by `keep.length + send.length` — the swap derives both sets.
 */
import type { SendResponse } from "@cashu/cashu-ts";
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
import {
  InsufficientFundsError,
  InvalidAmountError,
  isRecoverableOutputCollision,
} from "./errors.js";
import {
  COLLISION_BUMP,
  MAX_COLLISION_ATTEMPTS,
  decodeTokenForMint,
  effectiveCounter,
  keysetRefOf,
} from "./internal/deterministic.js";
import { loadWallet, runMintCall } from "./internal/wallet.js";
import { dedupeProofs, filterUnspentProofs } from "./proofStates.js";
import type { CashuProof } from "./tokenCodec.js";
import { encodeCashuToken, sumProofAmounts } from "./tokenCodec.js";

export interface CreateSendTokenArgs {
  readonly seed: CashuSeed;
  readonly mintUrl: string;
  readonly amount: number;
  /** Stored token strings to fund the send — all at `mintUrl`. */
  readonly tokens: ReadonlyArray<string>;
  readonly unit?: string | undefined;
}

export interface CreateSendTokenResult {
  readonly mintUrl: string;
  readonly unit: string;
  readonly sendAmount: number;
  readonly sendToken: string;
  readonly sendProofs: ReadonlyArray<CashuProof>;
  readonly keepAmount: number;
  /** Change to keep; none when the inputs matched the send amount exactly. */
  readonly keepToken: Option.Option<string>;
  readonly keepProofs: ReadonlyArray<CashuProof>;
}

export type CreateSendTokenError =
  | InvalidAmountError
  | InvalidCashuTokenError
  | WrongMintError
  | KeysetUnavailableError
  | InsufficientFundsError
  | CashuMintFailure
  | CounterStoreError;

export const createSendToken = (
  args: CreateSendTokenArgs,
): Effect.Effect<
  CreateSendTokenResult,
  CreateSendTokenError,
  HttpClient.HttpClient | CounterStore
> =>
  Effect.gen(function* () {
    const sendAmount = Number.isFinite(args.amount) ? Math.trunc(args.amount) : 0;
    if (sendAmount <= 0) {
      return yield* Effect.fail(new InvalidAmountError({ amount: args.amount }));
    }

    const counters = yield* CounterStore;
    const handle = yield* loadWallet({ mintUrl: args.mintUrl, unit: args.unit, seed: args.seed });
    const ref = keysetRefOf(handle);

    const allProofs: CashuProof[] = [];
    for (const tokenText of args.tokens) {
      const decoded = yield* decodeTokenForMint(handle, tokenText);
      allProofs.push(...decoded.proofs);
    }

    const deduped = dedupeProofs(allProofs);
    // Ignore already-spent proofs so stale stored rows don't block the send;
    // if the state check itself fails, keep all proofs (PoC behavior).
    const spendable = yield* runMintCall(handle.mintUrl, () =>
      handle.wallet.checkProofsStates(deduped),
    ).pipe(
      Effect.map((states) => filterUnspentProofs(deduped, states)),
      Effect.orElseSucceed(() => deduped),
    );

    const available = sumProofAmounts(spendable);
    if (available < sendAmount) {
      return yield* Effect.fail(
        new InsufficientFundsError({
          mintUrl: handle.mintUrl,
          required: sendAmount,
          available,
        }),
      );
    }

    const swapAttempts: Effect.Effect<SendResponse, CreateSendTokenError> = Effect.gen(
      function* () {
        let lastFailure: CashuMintFailure | null = null;

        for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt += 1) {
          const counter = effectiveCounter(yield* counters.getCounter(ref));
          const outcome = yield* Effect.either(
            runMintCall(handle.mintUrl, () =>
              handle.wallet.swap(sendAmount, spendable, { counter }),
            ),
          );
          if (outcome._tag === "Right") {
            yield* counters.ensureCounterAtLeast(
              ref,
              counter + outcome.right.keep.length + outcome.right.send.length,
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

    const swapped = yield* counters.withCounterLock(ref, swapAttempts);

    const sendProofs = swapped.send;
    const keepProofs = swapped.keep;
    const sendToken = yield* encodeCashuToken({
      mintUrl: handle.mintUrl,
      proofs: sendProofs,
      unit: handle.unit,
    });
    const keepToken =
      keepProofs.length > 0
        ? Option.some(
            yield* encodeCashuToken({
              mintUrl: handle.mintUrl,
              proofs: keepProofs,
              unit: handle.unit,
            }),
          )
        : Option.none<string>();

    return {
      mintUrl: handle.mintUrl,
      unit: handle.unit,
      sendAmount: sumProofAmounts(sendProofs),
      sendToken,
      sendProofs,
      keepAmount: sumProofAmounts(keepProofs),
      keepToken,
      keepProofs,
    };
  });
