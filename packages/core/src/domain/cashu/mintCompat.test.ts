/**
 * Mint-compatibility fallback (PoC quirk handling): when cashu-ts cannot
 * verify a mint's keyset id, the engine falls back to manual mint-data
 * loading (cheapest active hex keyset of the unit) so payments do not
 * silently fail — and proof-state checks work against the served keyset.
 */
import { hashToCurve } from "@cashu/cashu-ts/crypto/common";
import { bytesToNumber } from "@cashu/cashu-ts/crypto/util";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { ALICE_SEED, engineLayers, makeFundingToken } from "./__tests__/helpers.js";
import { FAKE_MINT_URL, FakeMint } from "./__tests__/fakeMint.js";
import { checkProofStates } from "./proofStates.js";
import { receiveToken } from "./receiveToken.js";
import { encodeCashuToken } from "./tokenCodec.js";

/** Like helpers.mintValidProof but stamped with the SERVED keyset id. */
const mintProofFor = (mint: FakeMint, amount: number, secret: string) => {
  const priv = mint.privKeys.get(amount);
  if (priv === undefined) throw new Error("missing key");
  return {
    id: mint.servedKeysetId,
    amount,
    secret,
    C: hashToCurve(utf8ToBytes(secret)).multiply(bytesToNumber(priv)).toHex(true),
  };
};

describe("keyset-verification fallback", () => {
  it("receives tokens at a mint whose keyset id does not verify", async () => {
    const mint = new FakeMint({ breakKeysetId: true });
    expect(mint.servedKeysetId).not.toBe(mint.keysetId);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        // funding proofs must carry the SERVED keyset id
        const proofs = [1, 2].map((amount, index) =>
          mintProofFor(mint, amount, `compat-${String(index)}`),
        );
        const token = yield* encodeCashuToken({
          mintUrl: FAKE_MINT_URL,
          unit: "sat",
          proofs,
        });
        return yield* receiveToken({ seed: ALICE_SEED, token });
      }).pipe(Effect.provide(engineLayers(mint))),
    );

    expect(result.amount).toBe(3);
    expect(result.proofs.every((proof) => proof.id === mint.servedKeysetId)).toBe(true);
  });

  it("checkProofStates works through the fallback wallet", async () => {
    const mint = new FakeMint({ breakKeysetId: true });
    const states = await Effect.runPromise(
      Effect.gen(function* () {
        const { proofs } = yield* makeFundingToken(mint, [1], "compat-state");
        mint.markSpent(proofs[0]!.secret);
        return yield* checkProofStates({
          mintUrl: FAKE_MINT_URL,
          proofs: proofs.map((proof) => ({ ...proof, id: mint.servedKeysetId })),
        });
      }).pipe(Effect.provide(engineLayers(mint))),
    );
    expect(states).toHaveLength(1);
    expect(states[0]?.state).toBe("SPENT");
  });
});
