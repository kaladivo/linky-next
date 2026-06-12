/**
 * nostrTestKit — shared utilities for the nostr domain tests ONLY.
 *
 * Excluded from the build (`tsconfig.build.json`); never exported from the
 * package. Tests import it directly, like other test-support modules.
 */
import { Effect, Layer } from "effect";

import { CurrentEnvironment } from "../environment/CurrentEnvironment.js";
import { decodeEnvironmentConfig } from "../environment/EnvironmentConfig.js";
import { Randomness } from "../../ports/Randomness.js";
import type { NostrEvent, NostrEventTemplate } from "./NostrEvent.js";
import { signNostrEvent } from "./NostrEvent.js";

/** Throwaway fixture key — same as `__fixtures__/signedEvents.golden.json`. */
export const TEST_SECRET_KEY_HEX =
  "5c0c523f52a5b6fad39ed2403092df8cebc36318b39383bca6c00808626fab3a";

export const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));

/** Deterministic "CSPRNG": constant bytes. Fine for BIP-340 aux randomness in tests. */
export const RandomnessFixed = Layer.succeed(Randomness, {
  nextBytes: (byteCount) => Effect.sync(() => new Uint8Array(byteCount).fill(0x42)),
});

/** Signs a test event with the fixture key; Randomness provided internally. */
export const makeSignedEvent = (
  template: Partial<NostrEventTemplate> = {},
): Effect.Effect<NostrEvent> =>
  signNostrEvent(
    {
      kind: 1,
      created_at: 1_718_000_000,
      tags: [],
      content: "test event",
      ...template,
    },
    hexToBytes(TEST_SECRET_KEY_HEX),
  ).pipe(Effect.provide(RandomnessFixed), Effect.orDie);

/** A `CurrentEnvironment` Layer with the given relay set (development profile). */
export const testEnvironmentLayer = (
  relayUrls: readonly [string, ...Array<string>],
): Layer.Layer<CurrentEnvironment> =>
  Layer.succeed(
    CurrentEnvironment,
    decodeEnvironmentConfig({
      profile: "development",
      network: "test",
      cashuMintUrl: "https://testnut.cashu.space",
      presetMintUrls: ["https://testnut.cashu.space"],
      nostrRelayUrls: relayUrls,
      evoluSyncUrls: ["wss://free.evoluhq.com"],
    }),
  );

/**
 * Cooperatively waits (via fiber yields, never the clock) until `check`
 * passes — for assertions that depend on background fibers settling after a
 * `TestClock.adjust`. Dies after `attempts` yields so a broken condition
 * fails the test instead of hanging it.
 */
export const awaitCondition = <E, R>(
  check: Effect.Effect<boolean, E, R>,
  label: string,
  attempts = 5_000,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    for (let i = 0; i < attempts; i += 1) {
      if (yield* check) return;
      yield* Effect.yieldNow();
    }
    return yield* Effect.die(new Error(`awaitCondition: not reached within budget: ${label}`));
  });
