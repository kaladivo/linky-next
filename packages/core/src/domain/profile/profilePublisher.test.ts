/**
 * layerProfilePublisher tests (issue #24) — the real ProfilePublisher port
 * implementation: signs kind 0 with the session's ACTIVE Nostr identity
 * (derived default and custom-key override, #20), treats the offline path
 * as success (event queued), and surfaces "no identity" as the port's
 * typed error. Fake relay network + TestClock; fully deterministic.
 */
import { Effect, Fiber, Layer, Option, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";

import { KeyValueStorage } from "../../ports/KeyValueStorage.js";
import { ProfilePublisher } from "../../ports/ProfilePublisher.js";
import type { Randomness } from "../../ports/Randomness.js";
import { SecureStorage } from "../../ports/SecureStorage.js";
import { activateCustomNostrKey } from "../identity/customNostrKey.js";
import { createIdentitySession } from "../identity/identitySession.js";
import { encodeNip19Key } from "../identity/nip19.js";
import type { FakeRelayNetwork } from "../nostr/fakeRelay.js";
import { makeFakeRelayNetwork } from "../nostr/fakeRelay.js";
import { verifyNostrEvent } from "../nostr/NostrEvent.js";
import {
  NostrPendingQueue,
  layerNostrPendingQueue,
  runPendingFlushLoop,
} from "../nostr/NostrPendingQueue.js";
import type { RelayPool, RelayPoolConfig } from "../nostr/RelayPool.js";
import { layerRelayPool } from "../nostr/RelayPool.js";
import { PROFILE_METADATA_KIND, parseProfileMetadataContent } from "../nostr/profileMetadata.js";
import {
  RandomnessFixed,
  awaitCondition,
  hexToBytes,
  testEnvironmentLayer,
} from "../nostr/nostrTestKit.js";
import { layerProfilePublisher } from "./profilePublisher.js";

const RELAY = "wss://profile-publisher.test";

const FIXED_MS = 1_720_000_000_000;

/** A second throwaway scalar for the custom-key test. Never a real identity. */
const CUSTOM_SECRET_KEY_HEX = "1111111111111111111111111111111111111111111111111111111111111111";

const testConfig: Partial<RelayPoolConfig> = {
  ackTimeout: "5 seconds",
  publishMaxAttempts: 2,
  publishRetryBaseDelay: "1 second",
  reconnectBaseDelay: "1 second",
  reconnectMaxDelay: "4 seconds",
};

const SecureStorageMemory = Layer.sync(SecureStorage, () => {
  const store = new Map<string, string>();
  return {
    get: (key: string) => Effect.sync(() => Option.fromNullable(store.get(key))),
    set: (key: string, value: string) => Effect.sync(() => void store.set(key, value)),
    delete: (key: string) => Effect.sync(() => void store.delete(key)),
  };
});

const SAMPLE_METADATA = {
  name: "Alice",
  displayName: "Alice",
  pictureUrl: "https://example.com/a.png",
  lightningAddress: "alice@linky.fit",
};

type HarnessServices =
  | ProfilePublisher
  | RelayPool
  | NostrPendingQueue
  | KeyValueStorage.KeyValueStore
  | SecureStorage
  | Randomness;

const withHarness = (
  options: { readonly prepare?: (network: FakeRelayNetwork) => Effect.Effect<void> },
  body: (harness: {
    readonly network: FakeRelayNetwork;
  }) => Effect.Effect<void, unknown, HarnessServices>,
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const network = yield* makeFakeRelayNetwork;
      if (options.prepare) yield* options.prepare(network);
      const poolLayer = layerRelayPool(testConfig).pipe(
        Layer.provide(network.transport),
        Layer.provide(testEnvironmentLayer([RELAY])),
      );
      const baseLayer = Layer.mergeAll(
        layerNostrPendingQueue.pipe(
          Layer.provideMerge(poolLayer),
          Layer.provideMerge(KeyValueStorage.layerMemory),
        ),
        SecureStorageMemory,
        RandomnessFixed,
      );
      const publisherLayer = layerProfilePublisher.pipe(Layer.provideMerge(baseLayer));
      yield* TestClock.setTime(FIXED_MS);
      yield* body({ network }).pipe(Effect.provide(publisherLayer));
    }).pipe(Effect.provide(TestContext.TestContext)),
  );

describe("layerProfilePublisher", () => {
  it("fails with ProfilePublishError when no identity session exists", async () => {
    await withHarness({}, () =>
      Effect.gen(function* () {
        const publisher = yield* ProfilePublisher;
        const error = yield* publisher.publishProfile(SAMPLE_METADATA).pipe(Effect.flip);
        expect(error._tag).toBe("ProfilePublishError");
      }),
    );
  });

  it("publishes kind 0 signed by the session's derived identity with the PoC content shape", async () => {
    await withHarness({}, ({ network }) =>
      Effect.gen(function* () {
        const session = yield* createIdentitySession;
        const publisher = yield* ProfilePublisher;
        yield* publisher.publishProfile(SAMPLE_METADATA);

        const relay = yield* network.relay(RELAY);
        const stored = yield* relay.storedEvents;
        expect(stored).toHaveLength(1);
        const event = stored[0]!;
        expect(event.kind).toBe(PROFILE_METADATA_KIND);
        expect(event.pubkey).toBe(session.activeNostr.identity.publicKeyHex);
        expect(event.pubkey).toBe(session.nostr.publicKeyHex);
        expect(verifyNostrEvent(event)).toBe(true);
        expect(parseProfileMetadataContent(event.content)).toStrictEqual({
          name: "Alice",
          displayName: "Alice",
          lud16: "alice@linky.fit",
          picture: "https://example.com/a.png",
          image: "https://example.com/a.png",
        });
      }),
    );
  });

  it("signs with the custom-key identity when one is active (#20)", async () => {
    await withHarness({}, ({ network }) =>
      Effect.gen(function* () {
        const session = yield* createIdentitySession;
        yield* activateCustomNostrKey(encodeNip19Key("nsec", hexToBytes(CUSTOM_SECRET_KEY_HEX)));

        const publisher = yield* ProfilePublisher;
        yield* publisher.publishProfile(SAMPLE_METADATA);

        const relay = yield* network.relay(RELAY);
        const stored = yield* relay.storedEvents;
        expect(stored).toHaveLength(1);
        // Signed by the override, not the derived default — the Layer
        // resolves the ACTIVE identity per publish.
        expect(stored[0]!.pubkey).not.toBe(session.nostr.publicKeyHex);
        expect(verifyNostrEvent(stored[0]!)).toBe(true);
      }),
    );
  });

  it("offline: resolves successfully (intent preserved) and the event is flushed on reconnect", async () => {
    await withHarness(
      {
        prepare: (network) =>
          Effect.flatMap(network.relay(RELAY), (relay) => relay.setOnline(false)),
      },
      ({ network }) =>
        Effect.gen(function* () {
          yield* createIdentitySession;
          const publisher = yield* ProfilePublisher;
          const queue = yield* NostrPendingQueue;

          const publishFiber = yield* Effect.fork(publisher.publishProfile(SAMPLE_METADATA));
          yield* TestClock.adjust("10 seconds");
          // The port succeeds: the signed event sits in the outbox.
          yield* Fiber.join(publishFiber);
          expect(yield* queue.pending).toHaveLength(1);

          const relay = yield* network.relay(RELAY);
          expect(yield* relay.publishedEvents).toStrictEqual([]);

          const loop = yield* Effect.fork(runPendingFlushLoop);
          yield* relay.setOnline(true);
          yield* TestClock.adjust("4 seconds");
          yield* awaitCondition(
            Effect.map(relay.storedEvents, (events) => events.length === 1),
            "queued profile publish flushed on reconnect",
          );
          expect(yield* queue.pending).toStrictEqual([]);
          yield* Fiber.interrupt(loop);
        }),
    );
  });
});
