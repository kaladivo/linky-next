/**
 * Shared helpers for cashu engine tests (test-only, excluded from build).
 */
import { OutputData, type SerializedBlindedMessage } from "@cashu/cashu-ts";
import { deriveSecret } from "@cashu/cashu-ts/crypto/client/NUT09";
import { hashToCurve } from "@cashu/cashu-ts/crypto/common";
import { bytesToNumber } from "@cashu/cashu-ts/crypto/util";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { readFileSync } from "node:fs";
import { Effect, Layer } from "effect";

import { CounterStore, CounterStoreMemory, type KeysetRef } from "../../../ports/CounterStore.js";
import type { HttpClient } from "../../../ports/index.js";
import { CashuSeed } from "../../identity/DerivedIdentities.js";
import type { CashuProof } from "../tokenCodec.js";
import { encodeCashuToken } from "../tokenCodec.js";
import type { FakeMint} from "./fakeMint.js";
import { FAKE_MINT_URL, fakeMintHttpLayer } from "./fakeMint.js";

interface FixtureFile {
  readonly identities: ReadonlyArray<{ readonly name: string; readonly cashuSeedHex: string }>;
}

const fixtures = JSON.parse(
  readFileSync(new URL("../__fixtures__/cashuWallet.golden.json", import.meta.url), "utf8"),
) as FixtureFile;

const aliceSeedHex = fixtures.identities.find((identity) =>
  identity.name.startsWith("alice"),
)?.cashuSeedHex;
if (aliceSeedHex === undefined) throw new Error("alice fixture missing");

/** The pinned alice wallet seed (matches #13 + #32 golden fixtures). */
export const ALICE_SEED = CashuSeed.make(hexToBytes(aliceSeedHex));

/** Expected NUT-13 proof secret for (ALICE_SEED, keysetId, counter). */
export const aliceSecretAt = (keysetId: string, counter: number): string =>
  bytesToHex(deriveSecret(ALICE_SEED, keysetId, counter));

/** A valid proof the fake mint will accept (C = k_amount * hashToCurve(secret)). */
export const mintValidProof = (mint: FakeMint, amount: number, secret: string): CashuProof => {
  const priv = mint.privKeys.get(amount);
  if (priv === undefined) throw new Error(`no fake mint key for amount ${String(amount)}`);
  return {
    id: mint.keysetId,
    amount,
    secret,
    C: hashToCurve(utf8ToBytes(secret)).multiply(bytesToNumber(priv)).toHex(true),
  };
};

/** Encodes a token of valid fake-mint proofs (one proof per amount). */
export const makeFundingToken = (
  mint: FakeMint,
  amounts: ReadonlyArray<number>,
  secretPrefix: string,
  mintUrl: string = FAKE_MINT_URL,
): Effect.Effect<{ token: string; proofs: CashuProof[] }> =>
  Effect.gen(function* () {
    const proofs = amounts.map((amount, index) =>
      mintValidProof(mint, amount, `${secretPrefix}-${String(index)}`),
    );
    const token = yield* Effect.orDie(
      encodeCashuToken({ mintUrl, unit: "sat", proofs }),
    );
    return { token, proofs };
  });

/** Deterministic blinded message for (ALICE_SEED, keysetId, counter, amount). */
export const aliceBlindedMessageAt = (
  keysetId: string,
  counter: number,
  amount: number,
): SerializedBlindedMessage =>
  OutputData.createSingleDeterministicData(amount, ALICE_SEED, counter, keysetId).blindedMessage;

export const fakeKeysetRef = (mint: FakeMint): KeysetRef => ({
  mintUrl: FAKE_MINT_URL,
  unit: "sat",
  keysetId: mint.keysetId,
});

/** One fresh fake-mint HttpClient + in-memory CounterStore environment. */
export const engineLayers = (
  mint: FakeMint,
): Layer.Layer<HttpClient.HttpClient | CounterStore> =>
  Layer.merge(fakeMintHttpLayer([[FAKE_MINT_URL, mint]]), CounterStoreMemory);

/** Runs an engine program against a fake mint with a fresh counter store. */
export const runEngine = <A, E>(
  mint: FakeMint,
  program: Effect.Effect<A, E, HttpClient.HttpClient | CounterStore>,
): Promise<A> => Effect.runPromise(program.pipe(Effect.provide(engineLayers(mint))));

/** Reads the deterministic counter for the fake mint keyset. */
export const readCounter = (ref: KeysetRef): Effect.Effect<number, never, CounterStore> =>
  Effect.flatMap(CounterStore, (store) => Effect.orDie(store.getCounter(ref)));
