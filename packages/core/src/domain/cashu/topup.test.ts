/**
 * Top-up behavior: quote state machine (UNPAID/PAID/ISSUED + local EXPIRED),
 * claim of paid quotes, deterministic NUT-09 recovery of already-issued
 * quotes (lost-session claim), and collision-vs-recovery disambiguation.
 */
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { CounterStoreMemory } from "../../ports/CounterStore.js";
import {
  ALICE_SEED,
  aliceBlindedMessageAt,
  aliceSecretAt,
  engineLayers,
  fakeKeysetRef,
  readCounter,
} from "./__tests__/helpers.js";
import { FAKE_MINT_URL, FakeMint, fakeMintHttpLayer } from "./__tests__/fakeMint.js";
import { checkTopupQuote, claimTopup, createTopupQuote } from "./topup.js";

describe("topup quote state machine", () => {
  it("creates an UNPAID quote with an invoice", async () => {
    const mint = new FakeMint();
    const quote = await Effect.runPromise(
      createTopupQuote({ mintUrl: FAKE_MINT_URL, amount: 16 }).pipe(
        Effect.provide(engineLayers(mint)),
      ),
    );
    expect(quote.state).toBe("UNPAID");
    expect(quote.invoice).toMatch(/^lnfake/);
    expect(quote.amount).toBe(16);
    expect(quote.quoteId).not.toBe("");
  });

  it("rechecks state on demand: UNPAID → PAID → ISSUED", async () => {
    const mint = new FakeMint();
    const layers = engineLayers(mint);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const quote = yield* createTopupQuote({ mintUrl: FAKE_MINT_URL, amount: 8 });
        const unpaid = yield* checkTopupQuote({ mintUrl: FAKE_MINT_URL, quoteId: quote.quoteId });
        mint.payQuote(quote.quoteId);
        const paid = yield* checkTopupQuote({ mintUrl: FAKE_MINT_URL, quoteId: quote.quoteId });
        yield* claimTopup({
          seed: ALICE_SEED,
          mintUrl: FAKE_MINT_URL,
          quoteId: quote.quoteId,
          amount: 8,
        });
        const issued = yield* checkTopupQuote({ mintUrl: FAKE_MINT_URL, quoteId: quote.quoteId });
        return { unpaid, paid, issued };
      }).pipe(Effect.provide(layers)),
    );
    expect(result.unpaid.state).toBe("UNPAID");
    expect(result.unpaid.claimable).toBe(false);
    expect(result.paid.state).toBe("PAID");
    expect(result.paid.claimable).toBe(true);
    expect(result.issued.state).toBe("ISSUED");
    expect(result.issued.claimable).toBe(true);
  });

  it("derives EXPIRED locally for an unpaid quote past its expiry", async () => {
    const mint = new FakeMint();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const quote = yield* createTopupQuote({ mintUrl: FAKE_MINT_URL, amount: 4 });
        mint.expireQuote(quote.quoteId);
        const status = yield* checkTopupQuote({
          mintUrl: FAKE_MINT_URL,
          quoteId: quote.quoteId,
        });
        const claim = yield* Effect.flip(
          claimTopup({
            seed: ALICE_SEED,
            mintUrl: FAKE_MINT_URL,
            quoteId: quote.quoteId,
            amount: 4,
          }),
        );
        return { status, claim };
      }).pipe(Effect.provide(engineLayers(mint))),
    );
    expect(result.status.state).toBe("EXPIRED");
    expect(result.status.claimable).toBe(false);
    expect(result.claim._tag).toBe("MintQuoteNotClaimableError");
    if (result.claim._tag === "MintQuoteNotClaimableError") {
      expect(result.claim.state).toBe("EXPIRED");
    }
  });
});

describe("claimTopup", () => {
  it("claims a paid quote with deterministic outputs and advances the counter", async () => {
    const mint = new FakeMint();
    const ref = fakeKeysetRef(mint);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const quoteId = mint.seedPaidQuote(12);
        const claimed = yield* claimTopup({
          seed: ALICE_SEED,
          mintUrl: FAKE_MINT_URL,
          quoteId,
          amount: 12,
        });
        const counter = yield* readCounter(ref);
        return { claimed, counter, quoteId };
      }).pipe(Effect.provide(engineLayers(mint))),
    );

    expect(result.claimed.amount).toBe(12);
    expect(result.claimed.recovered).toBe(false);
    // split [4, 8] at counters 1..2.
    expect(result.claimed.proofs.map((proof) => proof.secret).sort()).toEqual(
      [1, 2].map((counter) => aliceSecretAt(mint.keysetId, counter)).sort(),
    );
    expect(result.counter).toBe(3);
    expect(mint.mintQuotes.get(result.quoteId)?.state).toBe("ISSUED");
  });

  it("refuses an unpaid quote with MintQuoteNotClaimableError", async () => {
    const mint = new FakeMint();
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const quote = yield* createTopupQuote({ mintUrl: FAKE_MINT_URL, amount: 4 });
        return yield* Effect.flip(
          claimTopup({
            seed: ALICE_SEED,
            mintUrl: FAKE_MINT_URL,
            quoteId: quote.quoteId,
            amount: 4,
          }),
        );
      }).pipe(Effect.provide(engineLayers(mint))),
    );
    expect(failure._tag).toBe("MintQuoteNotClaimableError");
    if (failure._tag === "MintQuoteNotClaimableError") {
      expect(failure.state).toBe("UNPAID");
    }
  });

  it("recovers an already-issued quote via NUT-09 after counter loss", async () => {
    const mint = new FakeMint();
    const httpLayer = fakeMintHttpLayer([[FAKE_MINT_URL, mint]]);

    // Session 1: claim a paid quote, then "lose the device" (fresh counters).
    const quoteId = mint.seedPaidQuote(12);
    const first = await Effect.runPromise(
      claimTopup({ seed: ALICE_SEED, mintUrl: FAKE_MINT_URL, quoteId, amount: 12 }).pipe(
        Effect.provide(httpLayer),
        Effect.provide(CounterStoreMemory),
      ),
    );

    // Session 2: same quote (now ISSUED at the mint), counters reset to 0 —
    // mintProofs re-derives the same outputs → 11005 → NUT-09 recovery.
    const second = await Effect.runPromise(
      Effect.gen(function* () {
        const claimed = yield* claimTopup({
          seed: ALICE_SEED,
          mintUrl: FAKE_MINT_URL,
          quoteId,
          amount: 12,
        });
        const counter = yield* readCounter(fakeKeysetRef(mint));
        return { claimed, counter };
      }).pipe(Effect.provide(httpLayer), Effect.provide(CounterStoreMemory)),
    );

    expect(second.claimed.recovered).toBe(true);
    expect(second.claimed.amount).toBe(12);
    expect(second.claimed.proofs.map((proof) => proof.secret).sort()).toEqual(
      first.proofs.map((proof) => proof.secret).sort(),
    );
    // Counter ratcheted past the recovered range.
    expect(second.counter).toBe(3);
  });

  it("treats a spent colliding range as collision and mints with fresh outputs", async () => {
    const mint = new FakeMint();
    const ref = fakeKeysetRef(mint);

    // An unrelated past operation signed AND spent counters 1..2.
    for (const [counter, amount] of [
      [1, 4],
      [2, 8],
    ] as const) {
      const output = aliceBlindedMessageAt(mint.keysetId, counter, amount);
      mint.signOutput(output);
      mint.markSpent(aliceSecretAt(mint.keysetId, counter));
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const quoteId = mint.seedPaidQuote(12);
        const claimed = yield* claimTopup({
          seed: ALICE_SEED,
          mintUrl: FAKE_MINT_URL,
          quoteId,
          amount: 12,
        });
        const counter = yield* readCounter(ref);
        return { claimed, counter };
      }).pipe(Effect.provide(engineLayers(mint))),
    );

    expect(result.claimed.recovered).toBe(false);
    // Jumped past lastSigned=2 → fresh outputs at counters 3..4.
    expect(result.claimed.proofs.map((proof) => proof.secret).sort()).toEqual(
      [3, 4].map((counter) => aliceSecretAt(mint.keysetId, counter)).sort(),
    );
    expect(result.counter).toBe(5);
  });
});
