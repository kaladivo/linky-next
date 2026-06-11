/**
 * Randomness port — cryptographically secure random bytes for key and secret
 * generation (master identity entropy, Cashu secrets, Nostr ephemeral keys).
 *
 * Core cannot touch platform crypto (`globalThis.crypto`, `expo-crypto`,
 * `node:crypto`) directly, so randomness enters through this tag. The
 * implementation in `packages/platform` MUST be a CSPRNG — never `Math.random`.
 *
 * This port is for secret material only. For non-secret randomness (jitter,
 * shuffling, sampling) use Effect's built-in `Random` service, which is
 * deterministic under test.
 */
import { Context, Data } from "effect";
import type { Effect } from "effect";

/**
 * Expected failure of the platform RNG (entropy source unavailable, bridge
 * error). Rare, but key generation must surface it instead of silently
 * producing weak keys.
 */
export class RandomnessError extends Data.TaggedError("RandomnessError")<{
  readonly requestedBytes: number;
  readonly cause?: unknown;
}> {}

export interface RandomnessService {
  /**
   * Returns a fresh buffer of `byteCount` cryptographically secure random
   * bytes. The returned buffer is owned by the caller.
   */
  readonly nextBytes: (byteCount: number) => Effect.Effect<Uint8Array, RandomnessError>;
}

export class Randomness extends Context.Tag("@linky/core/Randomness")<
  Randomness,
  RandomnessService
>() {}
