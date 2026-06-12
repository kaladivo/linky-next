/**
 * saveProfileEdits workflow tests (#30): one save persists the local
 * profile, publishes kind 0 through the real ProfilePublisher Layer, and
 * publishes the kind-30315 NIP-38 general status — all signed by the
 * session's active identity. Fake relay network + TestClock.
 */
import { Effect, Layer, Option, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";

import { KeyValueStorage } from "../../ports/KeyValueStorage.js";
import type { ProfilePublisher } from "../../ports/ProfilePublisher.js";
import type { Randomness } from "../../ports/Randomness.js";
import { SecureStorage } from "../../ports/SecureStorage.js";
import { createIdentitySession } from "../identity/identitySession.js";
import type { FakeRelayNetwork } from "../nostr/fakeRelay.js";
import { makeFakeRelayNetwork } from "../nostr/fakeRelay.js";
import { verifyNostrEvent } from "../nostr/NostrEvent.js";
import type { NostrPendingQueue } from "../nostr/NostrPendingQueue.js";
import { layerNostrPendingQueue } from "../nostr/NostrPendingQueue.js";
import type { RelayPool, RelayPoolConfig } from "../nostr/RelayPool.js";
import { layerRelayPool } from "../nostr/RelayPool.js";
import { PROFILE_METADATA_KIND, parseProfileMetadataContent } from "../nostr/profileMetadata.js";
import {
  GENERAL_STATUS_IDENTIFIER,
  PROFILE_STATUS_KIND,
  buildProfileGeneralStatus,
} from "../nostr/profileStatus.js";
import { RandomnessFixed, testEnvironmentLayer } from "../nostr/nostrTestKit.js";
import { deriveInitialAvatarSelection } from "./generatedAvatar.js";
import type { LocalProfile } from "./localProfile.js";
import { loadLocalProfile } from "./localProfile.js";
import { layerProfilePublisher } from "./profilePublisher.js";
import { saveProfileEdits } from "./saveProfileEdits.js";

const RELAY = "wss://save-profile-edits.test";
const FIXED_MS = 1_720_000_000_000;

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

type HarnessServices =
  | ProfilePublisher
  | RelayPool
  | NostrPendingQueue
  | KeyValueStorage.KeyValueStore
  | SecureStorage
  | Randomness;

const withHarness = (
  body: (harness: {
    readonly network: FakeRelayNetwork;
  }) => Effect.Effect<void, unknown, HarnessServices>,
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const network = yield* makeFakeRelayNetwork;
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

const STATUS = buildProfileGeneralStatus({ currencies: ["BTC", "CZK"], text: "Hiking ⛰️" });

const profile: LocalProfile = {
  name: "Alice",
  pictureUrl: "https://example.com/a.png",
  pictureKind: "custom",
  avatarSelection: deriveInitialAvatarSelection("npub1alice"),
  lightningAddress: "npub1alice@linky.fit",
  status: STATUS,
};

describe("saveProfileEdits", () => {
  it("persists locally and publishes kind 0 + kind 30315 as the active identity", async () => {
    await withHarness(({ network }) =>
      Effect.gen(function* () {
        const session = yield* createIdentitySession;
        yield* saveProfileEdits({ profile });

        // Local persistence (#17 storage) including the status string.
        const stored = yield* loadLocalProfile;
        expect(Option.getOrNull(stored)).toEqual(profile);

        const relay = yield* network.relay(RELAY);
        const events = yield* relay.storedEvents;
        expect(events.map((event) => event.kind).sort()).toEqual([
          PROFILE_METADATA_KIND,
          PROFILE_STATUS_KIND,
        ]);

        const kind0 = events.find((event) => event.kind === PROFILE_METADATA_KIND)!;
        expect(kind0.pubkey).toBe(session.activeNostr.identity.publicKeyHex);
        expect(verifyNostrEvent(kind0)).toBe(true);
        expect(parseProfileMetadataContent(kind0.content)).toStrictEqual({
          name: "Alice",
          displayName: "Alice",
          lud16: "npub1alice@linky.fit",
          picture: "https://example.com/a.png",
          image: "https://example.com/a.png",
        });

        const kind30315 = events.find((event) => event.kind === PROFILE_STATUS_KIND)!;
        expect(kind30315.pubkey).toBe(session.activeNostr.identity.publicKeyHex);
        expect(verifyNostrEvent(kind30315)).toBe(true);
        expect(kind30315.tags).toEqual([["d", GENERAL_STATUS_IDENTIFIER]]);
        expect(kind30315.content).toBe("Hiking ⛰️\nBTC, CZK");
      }),
    );
  });

  it("publishes an empty status when the profile carries none (clears NIP-38)", async () => {
    await withHarness(({ network }) =>
      Effect.gen(function* () {
        yield* createIdentitySession;
        yield* saveProfileEdits({ profile: { ...profile, status: null } });

        const relay = yield* network.relay(RELAY);
        const events = yield* relay.storedEvents;
        const kind30315 = events.find((event) => event.kind === PROFILE_STATUS_KIND)!;
        expect(kind30315.content).toBe("");
      }),
    );
  });

  it("fails with ProfilePublishError when no identity session exists", async () => {
    await withHarness(() =>
      Effect.gen(function* () {
        const error = yield* saveProfileEdits({ profile }).pipe(Effect.flip);
        expect(error._tag).toBe("ProfilePublishError");
      }),
    );
  });
});
