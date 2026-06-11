/**
 * Send (emit token) behavior: structural single-mint enforcement, spent
 * proof filtering, insufficient funds, deterministic counter advancement.
 */
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  ALICE_SEED,
  engineLayers,
  fakeKeysetRef,
  makeFundingToken,
  readCounter,
} from "./__tests__/helpers.js";
import { FAKE_MINT_URL, FakeMint } from "./__tests__/fakeMint.js";
import { createSendToken } from "./sendToken.js";
import { parseCashuToken } from "./tokenCodec.js";

describe("createSendToken", () => {
  it("swaps into exact send + keep sets and advances the counter by both", async () => {
    const mint = new FakeMint();
    const ref = fakeKeysetRef(mint);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { token } = yield* makeFundingToken(mint, [4, 2], "send-funding");
        const sent = yield* createSendToken({
          seed: ALICE_SEED,
          mintUrl: FAKE_MINT_URL,
          amount: 5,
          tokens: [token],
        });
        const counter = yield* readCounter(ref);
        const parsedSend = yield* parseCashuToken(sent.sendToken);
        return { sent, counter, parsedSend };
      }).pipe(Effect.provide(engineLayers(mint))),
    );

    expect(result.sent.sendAmount).toBe(5);
    expect(result.sent.keepAmount).toBe(1);
    expect(result.parsedSend.amount).toBe(5);
    expect(result.parsedSend.mintUrl).toBe(FAKE_MINT_URL);
    expect(Option.isSome(result.sent.keepToken)).toBe(true);
    // counter = 1 (floor) + keep + send derivations
    expect(result.counter).toBe(
      1 + result.sent.keepProofs.length + result.sent.sendProofs.length,
    );
  });

  it("ignores already-spent funding proofs instead of failing the swap", async () => {
    const mint = new FakeMint();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { token, proofs } = yield* makeFundingToken(mint, [4, 2, 1], "stale-funding");
        // 4-sat proof is stale (spent) — send 3 still works from 2+1.
        mint.markSpent(proofs[0]!.secret);
        return yield* createSendToken({
          seed: ALICE_SEED,
          mintUrl: FAKE_MINT_URL,
          amount: 3,
          tokens: [token],
        });
      }).pipe(Effect.provide(engineLayers(mint))),
    );
    expect(result.sendAmount).toBe(3);
    expect(result.keepAmount).toBe(0);
    expect(Option.isNone(result.keepToken)).toBe(true);
  });

  it("fails with InsufficientFundsError when spendable value is too low", async () => {
    const mint = new FakeMint();
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const { token, proofs } = yield* makeFundingToken(mint, [4, 2], "low-funding");
        mint.markSpent(proofs[0]!.secret); // only 2 sat left
        return yield* Effect.flip(
          createSendToken({
            seed: ALICE_SEED,
            mintUrl: FAKE_MINT_URL,
            amount: 5,
            tokens: [token],
          }),
        );
      }).pipe(Effect.provide(engineLayers(mint))),
    );
    expect(failure._tag).toBe("InsufficientFundsError");
    if (failure._tag === "InsufficientFundsError") {
      expect(failure.required).toBe(5);
      expect(failure.available).toBe(2);
    }
  });

  it("structurally refuses funding tokens from another mint", async () => {
    const mint = new FakeMint();
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const { token } = yield* makeFundingToken(
          mint,
          [4],
          "foreign-funding",
          "https://other-mint.test",
        );
        return yield* Effect.flip(
          createSendToken({
            seed: ALICE_SEED,
            mintUrl: FAKE_MINT_URL,
            amount: 4,
            tokens: [token],
          }),
        );
      }).pipe(Effect.provide(engineLayers(mint))),
    );
    expect(failure._tag).toBe("WrongMintError");
    if (failure._tag === "WrongMintError") {
      expect(failure.expectedMintUrl).toBe(FAKE_MINT_URL);
      expect(failure.tokenMintUrl).toBe("https://other-mint.test");
    }
  });

  it("rejects non-positive amounts", async () => {
    const mint = new FakeMint();
    const failure = await Effect.runPromise(
      Effect.flip(
        createSendToken({ seed: ALICE_SEED, mintUrl: FAKE_MINT_URL, amount: 0, tokens: [] }),
      ).pipe(Effect.provide(engineLayers(mint))),
    );
    expect(failure._tag).toBe("InvalidAmountError");
  });
});
