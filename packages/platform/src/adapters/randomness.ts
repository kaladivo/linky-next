/**
 * Randomness adapter — maps a CSPRNG-style native module (expo-crypto, which
 * draws from the platform's secure entropy source) onto core's `Randomness`
 * port. Never back this with `Math.random`.
 */
import type { RandomnessService } from "@linky/core";
import { Randomness, RandomnessError } from "@linky/core";
import { Effect, Layer } from "effect";

/** The subset of `expo-crypto` this adapter needs. */
export interface CryptoNativeModule {
  readonly getRandomBytesAsync: (byteCount: number) => Promise<Uint8Array>;
}

export const makeRandomness = (native: CryptoNativeModule): RandomnessService => ({
  nextBytes: (byteCount) =>
    Effect.tryPromise({
      try: () => native.getRandomBytesAsync(byteCount),
      catch: (cause) => new RandomnessError({ requestedBytes: byteCount, cause }),
    }),
});

export const layerRandomness = (native: CryptoNativeModule): Layer.Layer<Randomness> =>
  Layer.succeed(Randomness, makeRandomness(native));
