/**
 * Receive (accept token) behavior: deterministic counters, collision retry
 * ladder (NUT-09 precise jump on 11005, fixed +64 on 11004), counter
 * advancement, and error typing. All against the in-process fake mint —
 * never a real one.
 */
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  ALICE_SEED,
  aliceBlindedMessageAt,
  aliceSecretAt,
  engineLayers,
  fakeKeysetRef,
  makeFundingToken,
  readCounter,
} from "./__tests__/helpers.js";
import { FAKE_MINT_URL, FakeMint } from "./__tests__/fakeMint.js";
import { encodeCashuToken, parseCashuToken } from "./tokenCodec.js";
import { receiveToken } from "./receiveToken.js";

describe("receiveToken", () => {
  it("swaps incoming proofs for deterministic ones and advances the counter", async () => {
    const mint = new FakeMint();
    const ref = fakeKeysetRef(mint);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { token, proofs } = yield* makeFundingToken(mint, [1, 2, 4], "incoming");
        const received = yield* receiveToken({ seed: ALICE_SEED, token });
        const counter = yield* readCounter(ref);
        return { received, counter, fundingProofs: proofs };
      }).pipe(Effect.provide(engineLayers(mint))),
    );

    expect(result.received.amount).toBe(7);
    expect(result.received.mintUrl).toBe(FAKE_MINT_URL);
    expect(result.received.unit).toBe("sat");
    // Slot 0 is never consumed: outputs sit at counters 1..3.
    expect(result.received.proofs.map((proof) => proof.secret).sort()).toEqual(
      [1, 2, 3].map((counter) => aliceSecretAt(mint.keysetId, counter)).sort(),
    );
    expect(result.counter).toBe(4);
    // The incoming proofs are now spent at the mint.
    for (const proof of result.fundingProofs) {
      expect(mint.proofStates.get(mint.yOfSecret(proof.secret))).toBe("SPENT");
    }
  });

  it("re-encodes the accepted token and preserves the memo", async () => {
    const mint = new FakeMint();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { proofs } = yield* makeFundingToken(mint, [2], "memo-funding");
        const token = yield* encodeCashuToken({
          mintUrl: FAKE_MINT_URL,
          unit: "sat",
          memo: "thanks!",
          proofs,
        });
        const received = yield* receiveToken({ seed: ALICE_SEED, token });
        const parsed = yield* parseCashuToken(received.token);
        return parsed;
      }).pipe(Effect.provide(engineLayers(mint))),
    );
    expect(Option.getOrNull(result.memo)).toBe("thanks!");
    expect(result.amount).toBe(2);
  });

  it("on OutputsAlreadySigned, jumps precisely past the signed range via NUT-09", async () => {
    const mint = new FakeMint();
    const ref = fakeKeysetRef(mint);
    // A prior session signed counters 1..3 (amounts of the [1,2,4] split).
    for (const [counter, amount] of [
      [1, 1],
      [2, 2],
      [3, 4],
    ] as const) {
      mint.signOutput(aliceBlindedMessageAt(mint.keysetId, counter, amount));
    }

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { token } = yield* makeFundingToken(mint, [1, 2, 4], "oas-funding");
        const received = yield* receiveToken({ seed: ALICE_SEED, token });
        const counter = yield* readCounter(ref);
        return { received, counter };
      }).pipe(Effect.provide(engineLayers(mint))),
    );

    // Restore reported lastCounterWithSignature = 3 → retry from 4.
    expect(result.received.proofs.map((proof) => proof.secret).sort()).toEqual(
      [4, 5, 6].map((counter) => aliceSecretAt(mint.keysetId, counter)).sort(),
    );
    expect(result.counter).toBe(7);
  });

  it("on OutputsArePending, bumps the counter by 64 and retries", async () => {
    const mint = new FakeMint();
    const ref = fakeKeysetRef(mint);
    // An orphan unsigned promise occupies the B_ the first attempt would use.
    mint.pendingBs.add(aliceBlindedMessageAt(mint.keysetId, 1, 1).B_);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { token } = yield* makeFundingToken(mint, [1, 2, 4], "oap-funding");
        const received = yield* receiveToken({ seed: ALICE_SEED, token });
        const counter = yield* readCounter(ref);
        return { received, counter };
      }).pipe(Effect.provide(engineLayers(mint))),
    );

    // 0 + 64 → outputs at counters 64..66.
    expect(result.received.proofs.map((proof) => proof.secret).sort()).toEqual(
      [64, 65, 66].map((counter) => aliceSecretAt(mint.keysetId, counter)).sort(),
    );
    expect(result.counter).toBe(67);
  });

  it("fails with InvalidCashuTokenError for unparseable input", async () => {
    const mint = new FakeMint();
    const failure = await Effect.runPromise(
      Effect.flip(receiveToken({ seed: ALICE_SEED, token: "not a token" })).pipe(
        Effect.provide(engineLayers(mint)),
      ),
    );
    expect(failure._tag).toBe("InvalidCashuTokenError");
  });

  it("surfaces non-collision mint failures as typed errors without retry", async () => {
    const mint = new FakeMint();
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const { token, proofs } = yield* makeFundingToken(mint, [1], "spent-funding");
        // Already spent at the mint → 11001 on swap.
        mint.markSpent(proofs[0]!.secret);
        return yield* Effect.flip(receiveToken({ seed: ALICE_SEED, token }));
      }).pipe(Effect.provide(engineLayers(mint))),
    );
    expect(failure._tag).toBe("MintProtocolError");
    if (failure._tag === "MintProtocolError") {
      expect(failure.code).toBe(11001);
    }
  });
});
