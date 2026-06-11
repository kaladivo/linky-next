/**
 * Melt (pay invoice) behavior: fee handling, NUT-08 change preservation,
 * counter advancement past the full blank range, insufficient funds, and
 * structural single-mint funding.
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
import { payInvoice } from "./meltToken.js";
import { parseCashuToken } from "./tokenCodec.js";

describe("payInvoice", () => {
  it("pays the quote and preserves the remainder as change proofs", async () => {
    const mint = new FakeMint();
    const ref = fakeKeysetRef(mint);
    mint.feePaidPerMelt = 1;

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { token } = yield* makeFundingToken(mint, [32, 2], "melt-funding");
        const paid = yield* payInvoice({
          seed: ALICE_SEED,
          mintUrl: FAKE_MINT_URL,
          invoice: "fakeinvoice:32:2",
          tokens: [token],
        });
        const counter = yield* readCounter(ref);
        return { paid, counter };
      }).pipe(Effect.provide(engineLayers(mint))),
    );

    expect(result.paid.paidAmount).toBe(32);
    expect(result.paid.feeReserve).toBe(2);
    expect(result.paid.feePaid).toBe(1);
    // inputs 34 - amount 32 - feePaid 1 = 1 sat change, preserved.
    expect(result.paid.changeAmount).toBe(1);
    expect(Option.isSome(result.paid.changeToken)).toBe(true);
    expect(Option.getOrNull(result.paid.paymentPreimage)).toBe("fake-preimage");
    if (Option.isSome(result.paid.changeToken)) {
      const parsed = await Effect.runPromise(parseCashuToken(result.paid.changeToken.value));
      expect(parsed.amount).toBe(1);
      expect(parsed.mintUrl).toBe(FAKE_MINT_URL);
    }
    // fee_reserve 2 → 1 blank output; change.length 1 → counter = 1 + max(1,1).
    expect(result.counter).toBe(2);
  });

  it("advances the counter past unsigned blanks even with zero change", async () => {
    const mint = new FakeMint();
    const ref = fakeKeysetRef(mint);
    mint.feePaidPerMelt = 4; // eats the whole reserve → no change signed

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { token } = yield* makeFundingToken(mint, [32, 4], "melt-zero-change");
        const paid = yield* payInvoice({
          seed: ALICE_SEED,
          mintUrl: FAKE_MINT_URL,
          invoice: "fakeinvoice:32:4",
          tokens: [token],
        });
        const counter = yield* readCounter(ref);
        return { paid, counter };
      }).pipe(Effect.provide(engineLayers(mint))),
    );

    expect(result.paid.changeAmount).toBe(0);
    expect(Option.isNone(result.paid.changeToken)).toBe(true);
    expect(result.paid.feePaid).toBe(4);
    // fee_reserve 4 → ceil(log2(4)) = 2 blank outputs consumed, 0 signed:
    // the counter must still advance past BOTH blank slots.
    expect(result.counter).toBe(1 + 2);
  });

  it("fails with InsufficientFundsError including fee reserve in the requirement", async () => {
    const mint = new FakeMint();
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const { token } = yield* makeFundingToken(mint, [32], "melt-low");
        return yield* Effect.flip(
          payInvoice({
            seed: ALICE_SEED,
            mintUrl: FAKE_MINT_URL,
            invoice: "fakeinvoice:32:2",
            tokens: [token],
          }),
        );
      }).pipe(Effect.provide(engineLayers(mint))),
    );
    expect(failure._tag).toBe("InsufficientFundsError");
    if (failure._tag === "InsufficientFundsError") {
      expect(failure.required).toBe(34);
      expect(failure.available).toBe(32);
    }
  });

  it("refuses funding tokens from a different mint (no cross-mint melt)", async () => {
    const mint = new FakeMint();
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const { token } = yield* makeFundingToken(
          mint,
          [32, 2],
          "melt-foreign",
          "https://other-mint.test",
        );
        return yield* Effect.flip(
          payInvoice({
            seed: ALICE_SEED,
            mintUrl: FAKE_MINT_URL,
            invoice: "fakeinvoice:32:2",
            tokens: [token],
          }),
        );
      }).pipe(Effect.provide(engineLayers(mint))),
    );
    expect(failure._tag).toBe("WrongMintError");
  });

  it("surfaces invalid invoices as MintProtocolError from the quote step", async () => {
    const mint = new FakeMint();
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const { token } = yield* makeFundingToken(mint, [32], "melt-bad-invoice");
        return yield* Effect.flip(
          payInvoice({
            seed: ALICE_SEED,
            mintUrl: FAKE_MINT_URL,
            invoice: "lnbc-not-fake-format",
            tokens: [token],
          }),
        );
      }).pipe(Effect.provide(engineLayers(mint))),
    );
    expect(failure._tag).toBe("MintProtocolError");
  });
});
