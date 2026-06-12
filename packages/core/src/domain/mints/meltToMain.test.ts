/**
 * Cross-mint melt-to-main behavior (issue #42) against TWO fake mints:
 * success, probe-driven fee sizing, the ladder/extension retry path,
 * remainder preservation, the claimable-quote handoff (claimTopup at the
 * target), the persist-before-melt hook ordering, and the failure paths
 * (no spendable funds, wrong-mint funding, non-retryable mint errors).
 */
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import type { CounterStore } from "../../ports/CounterStore.js";
import { CounterStoreMemory } from "../../ports/CounterStore.js";
import type { HttpClient } from "../../ports/index.js";
import { FakeMint, fakeMintHttpLayer } from "../cashu/__tests__/fakeMint.js";
import { ALICE_SEED, makeFundingToken } from "../cashu/__tests__/helpers.js";
import { claimTopup } from "../cashu/topup.js";
import { parseCashuToken } from "../cashu/tokenCodec.js";
import type { MeltToMainQuote } from "./meltToMain.js";
import { meltToMainMint } from "./meltToMain.js";

const SOURCE_URL = "https://source.fakemint.test";
const TARGET_URL = "https://target.fakemint.test";

const layersFor = (source: FakeMint, target: FakeMint) =>
  Layer.merge(
    fakeMintHttpLayer([
      [SOURCE_URL, source],
      [TARGET_URL, target],
    ]),
    CounterStoreMemory,
  );

const runCross = <A, E>(
  source: FakeMint,
  target: FakeMint,
  program: Effect.Effect<A, E, HttpClient.HttpClient | CounterStore>,
): Promise<A> => Effect.runPromise(program.pipe(Effect.provide(layersFor(source, target))));

describe("meltToMainMint", () => {
  it("moves the full balance when no fees apply (single attempt, no remainder)", async () => {
    const source = new FakeMint();
    const target = new FakeMint({ bolt11MintQuotes: true });

    const result = await runCross(
      source,
      target,
      Effect.gen(function* () {
        const { token } = yield* makeFundingToken(source, [64, 32, 4], "m2m-a", SOURCE_URL);
        return yield* meltToMainMint({
          seed: ALICE_SEED,
          sourceMintUrl: SOURCE_URL,
          targetMintUrl: TARGET_URL,
          tokens: [token],
          retryDelayMillis: 0,
        });
      }),
    );

    expect(result.amountSat).toBe(100);
    expect(result.attempts).toBe(1);
    expect(result.feeReserve).toBe(0);
    expect(result.feePaid).toBe(0);
    expect(result.changeAmount).toBe(0);
    expect(Option.isNone(result.changeToken)).toBe(true);
    expect(result.sourceMintUrl).toBe(SOURCE_URL);
    expect(result.targetMintUrl).toBe(TARGET_URL);
    // The melt paid the target quote's invoice (mint-side state PAID-able).
    expect(target.mintQuotes.get(result.quoteId)?.amount).toBe(100);
  });

  it("sizes the first attempt from the fee probe and preserves the remainder", async () => {
    const source = new FakeMint();
    const target = new FakeMint({ bolt11MintQuotes: true });
    source.bolt11FeeReserve = 2; // melt quotes demand 2 sat reserve
    source.feePaidPerMelt = 1; // actual LN fee 1 sat → 1 sat change

    const result = await runCross(
      source,
      target,
      Effect.gen(function* () {
        const { token } = yield* makeFundingToken(source, [64, 32, 4], "m2m-b", SOURCE_URL);
        return yield* meltToMainMint({
          seed: ALICE_SEED,
          sourceMintUrl: SOURCE_URL,
          targetMintUrl: TARGET_URL,
          tokens: [token],
          retryDelayMillis: 0,
        });
      }),
    );

    // balance 100 - fee_reserve 2 - input fee 0 → first real attempt is 98.
    expect(result.amountSat).toBe(98);
    expect(result.attempts).toBe(1);
    expect(result.feeReserve).toBe(2);
    expect(result.feePaid).toBe(1);
    // inputs 100 - paid 98 - LN fee 1 = 1 sat NUT-08 change at the SOURCE.
    expect(result.changeAmount).toBe(1);
    const changeToken = Option.getOrNull(result.changeToken);
    expect(changeToken).not.toBeNull();
    const parsedChange = await Effect.runPromise(parseCashuToken(changeToken!));
    expect(parsedChange.mintUrl).toBe(SOURCE_URL);
    expect(parsedChange.amount).toBe(1);
  });

  it("walks the retry ladder when the probe is unavailable (rate-limited)", async () => {
    const source = new FakeMint();
    const target = new FakeMint({ bolt11MintQuotes: true });
    source.bolt11FeeReserve = 2;
    target.failNextMintQuotes = 1; // kills the probe quote only

    const result = await runCross(
      source,
      target,
      Effect.gen(function* () {
        const { token } = yield* makeFundingToken(source, [64, 32, 4], "m2m-c", SOURCE_URL);
        return yield* meltToMainMint({
          seed: ALICE_SEED,
          sourceMintUrl: SOURCE_URL,
          targetMintUrl: TARGET_URL,
          tokens: [token],
          retryDelayMillis: 0,
        });
      }),
    );

    // Ladder [100,99,98,…]: 100 needs 102, 99 needs 101 → both Insufficient;
    // 98 + reserve 2 fits the 100 sat balance exactly.
    expect(result.amountSat).toBe(98);
    expect(result.attempts).toBe(3);
    expect(result.changeAmount).toBe(2); // reserve unspent (feePaid 0) → change
  });

  it("extends the queue by the exact reported shortage (small-balance path)", async () => {
    const source = new FakeMint();
    const target = new FakeMint({ bolt11MintQuotes: true });
    source.bolt11FeeReserve = 4;
    target.failNextMintQuotes = 1; // force the ladder path

    const result = await runCross(
      source,
      target,
      Effect.gen(function* () {
        const { token } = yield* makeFundingToken(source, [8], "m2m-d", SOURCE_URL);
        return yield* meltToMainMint({
          seed: ALICE_SEED,
          sourceMintUrl: SOURCE_URL,
          targetMintUrl: TARGET_URL,
          tokens: [token],
          retryDelayMillis: 0,
        });
      }),
    );

    // Initial ladder for 8: [8,7,6,5,3]; every attempt ≥5 needs amount+4.
    // The first failure (need 12, have 8) appends the shortage step 4; 3
    // (already queued) succeeds first: 3 + 4 = 7 ≤ 8.
    expect(result.amountSat).toBe(3);
    expect(result.attempts).toBe(5);
    // NUT-08 returns the unspent reserve: inputs 8 - paid 3 - LN fee 0 = 5.
    expect(result.changeAmount).toBe(5);
  });

  it("hands over a claimable target quote (claimTopup completes the move)", async () => {
    const source = new FakeMint();
    const target = new FakeMint({ bolt11MintQuotes: true });
    source.bolt11FeeReserve = 2;
    const quotesSeen: MeltToMainQuote[] = [];

    const { result, claimed } = await runCross(
      source,
      target,
      Effect.gen(function* () {
        const { token } = yield* makeFundingToken(source, [64, 32, 4], "m2m-e", SOURCE_URL);
        const result = yield* meltToMainMint({
          seed: ALICE_SEED,
          sourceMintUrl: SOURCE_URL,
          targetMintUrl: TARGET_URL,
          tokens: [token],
          retryDelayMillis: 0,
          onQuoteCreated: (quote) => quotesSeen.push(quote),
        });
        // LN settlement: the melt paid the invoice → the quote turns PAID.
        target.payQuote(result.quoteId);
        const claimed = yield* claimTopup({
          seed: ALICE_SEED,
          mintUrl: TARGET_URL,
          quoteId: result.quoteId,
          amount: result.amountSat,
        });
        return { result, claimed };
      }),
    );

    expect(claimed.amount).toBe(result.amountSat);
    expect(claimed.mintUrl).toBe(TARGET_URL);
    const parsedClaim = await Effect.runPromise(parseCashuToken(claimed.token));
    expect(parsedClaim.amount).toBe(result.amountSat);
    // The persist-before-melt hook saw the winning quote (and only real
    // attempts — the probe quote never reaches the hook).
    expect(quotesSeen.map((quote) => quote.quoteId)).toContain(result.quoteId);
    expect(quotesSeen.at(-1)?.quoteId).toBe(result.quoteId);
    expect(quotesSeen.at(-1)?.amountSat).toBe(result.amountSat);
  });

  it("fails with ConsolidationUnavailableError when every proof is spent", async () => {
    const source = new FakeMint();
    const target = new FakeMint({ bolt11MintQuotes: true });

    const outcome = await runCross(
      source,
      target,
      Effect.gen(function* () {
        const { token, proofs } = yield* makeFundingToken(source, [16, 4], "m2m-f", SOURCE_URL);
        for (const proof of proofs) source.markSpent(proof.secret);
        return yield* Effect.either(
          meltToMainMint({
            seed: ALICE_SEED,
            sourceMintUrl: SOURCE_URL,
            targetMintUrl: TARGET_URL,
            tokens: [token],
            retryDelayMillis: 0,
          }),
        );
      }),
    );

    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") {
      expect(outcome.left._tag).toBe("ConsolidationUnavailableError");
    }
  });

  it("rejects funding tokens from a different mint (WrongMintError)", async () => {
    const source = new FakeMint();
    const target = new FakeMint({ bolt11MintQuotes: true });

    const outcome = await runCross(
      source,
      target,
      Effect.gen(function* () {
        // Token encoded for the TARGET url cannot fund a SOURCE melt.
        const { token } = yield* makeFundingToken(source, [16], "m2m-g", TARGET_URL);
        return yield* Effect.either(
          meltToMainMint({
            seed: ALICE_SEED,
            sourceMintUrl: SOURCE_URL,
            targetMintUrl: TARGET_URL,
            tokens: [token],
            retryDelayMillis: 0,
          }),
        );
      }),
    );

    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") expect(outcome.left._tag).toBe("WrongMintError");
  });

  it("aborts on non-retryable mint failures (unparseable target invoices)", async () => {
    const source = new FakeMint();
    // No bolt11MintQuotes: the source mint cannot quote `lnfake…` invoices.
    const target = new FakeMint();

    const outcome = await runCross(
      source,
      target,
      Effect.gen(function* () {
        const { token } = yield* makeFundingToken(source, [16, 4], "m2m-h", SOURCE_URL);
        return yield* Effect.either(
          meltToMainMint({
            seed: ALICE_SEED,
            sourceMintUrl: SOURCE_URL,
            targetMintUrl: TARGET_URL,
            tokens: [token],
            retryDelayMillis: 0,
          }),
        );
      }),
    );

    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") {
      expect(outcome.left._tag).toBe("MintProtocolError");
    }
  });
});
