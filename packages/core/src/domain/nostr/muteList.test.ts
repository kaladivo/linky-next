/**
 * Mute-list tests (issue #28) — kind 10000 with PoC p-tag shape, the
 * MERGE-with-existing-entries contract ("publishing a block merges with the
 * user's existing mute list instead of replacing unrelated entries"), the
 * newest-replaceable-event-wins read, and the offline → queued → flushed
 * path. Fake relay network + TestClock; fully deterministic.
 */
import { Effect, Fiber, Layer, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";

import { KeyValueStorage } from "../../ports/KeyValueStorage.js";
import type { Randomness } from "../../ports/Randomness.js";
import type { ActiveNostrIdentity } from "../identity/customNostrKey.js";
import { nostrIdentityFromNsec } from "../identity/customNostrKey.js";
import { encodeNip19Key } from "../identity/nip19.js";
import type { FakeRelayNetwork } from "./fakeRelay.js";
import { makeFakeRelayNetwork } from "./fakeRelay.js";
import type { NostrEvent } from "./NostrEvent.js";
import { verifyNostrEvent } from "./NostrEvent.js";
import {
  NostrPendingQueue,
  layerNostrPendingQueue,
  runPendingFlushLoop,
} from "./NostrPendingQueue.js";
import type { RelayPool, RelayPoolConfig } from "./RelayPool.js";
import { layerRelayPool } from "./RelayPool.js";
import {
  MUTE_LIST_KIND,
  fetchCurrentMuteList,
  mergeMutedPubkeys,
  muteListTemplate,
  mutedPubkeysOfEvent,
  normalizeMutedPubkeys,
  publishMuteList,
} from "./muteList.js";
import { npubToPublicKeyHex } from "./npub.js";
import type { PublishMuteListResult } from "./muteList.js";
import {
  RandomnessFixed,
  TEST_SECRET_KEY_HEX,
  awaitCondition,
  hexToBytes,
  makeSignedEvent,
  testEnvironmentLayer,
} from "./nostrTestKit.js";

const RELAY = "wss://mute-list.test";

const PUBKEY_A = "1af20e896eca5cefb89c0d866d3a1bbd8ddd4413b615689c9c61513043966b7c";
const PUBKEY_B = "83beffec065f05ea4b58bb4050c7f358283e27c5556874ddab279dfdd6cef670";
const PUBKEY_C = "142715675faf8da1ecc4d51e0b9e539fa0d52fdd96ed60dbe99adb15d6b05ad9";

const FIXED_MS = 1_720_000_000_000;

/** Short fetch window so tests only adjust the TestClock by 2 seconds. */
const QUERY_WINDOW = { queryWindow: "2 seconds" } as const;

const testConfig: Partial<RelayPoolConfig> = {
  ackTimeout: "5 seconds",
  publishMaxAttempts: 2,
  publishRetryBaseDelay: "1 second",
  reconnectBaseDelay: "1 second",
  reconnectMaxDelay: "4 seconds",
};

const derivedIdentity = (secretKeyHex: string): Effect.Effect<ActiveNostrIdentity> =>
  nostrIdentityFromNsec(encodeNip19Key("nsec", hexToBytes(secretKeyHex))).pipe(
    Effect.map((identity) => ({ source: "derived", identity }) as const),
    Effect.orDie,
  );

const withHarness = (
  options: { readonly prepare?: (network: FakeRelayNetwork) => Effect.Effect<void> },
  body: (harness: {
    readonly network: FakeRelayNetwork;
  }) => Effect.Effect<
    void,
    unknown,
    RelayPool | NostrPendingQueue | KeyValueStorage.KeyValueStore | Randomness
  >,
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const network = yield* makeFakeRelayNetwork;
      if (options.prepare) yield* options.prepare(network);
      const poolLayer = layerRelayPool(testConfig).pipe(
        Layer.provide(network.transport),
        Layer.provide(testEnvironmentLayer([RELAY])),
      );
      const queueLayer = layerNostrPendingQueue.pipe(
        Layer.provideMerge(poolLayer),
        Layer.provideMerge(KeyValueStorage.layerMemory),
      );
      yield* TestClock.setTime(FIXED_MS);
      yield* body({ network }).pipe(Effect.provide([queueLayer, RandomnessFixed]));
    }).pipe(Effect.provide(TestContext.TestContext)),
  );

/** Forks the publish, elapses the 2s fetch window (+ `extra`), joins. */
const runPublish = (
  identity: ActiveNostrIdentity,
  blocked: ReadonlyArray<string>,
  extraAdjust: "0 seconds" | "10 seconds" = "0 seconds",
): Effect.Effect<
  PublishMuteListResult,
  unknown,
  RelayPool | NostrPendingQueue | Randomness
> =>
  Effect.gen(function* () {
    const fiber = yield* Effect.fork(publishMuteList(identity, blocked, QUERY_WINDOW));
    yield* TestClock.adjust("2 seconds");
    yield* TestClock.adjust(extraAdjust);
    return yield* Fiber.join(fiber);
  });

/** A kind-10000 event signed with the test identity's key. */
const muteListEvent = (
  pubkeys: ReadonlyArray<string>,
  createdAtSec: number,
): Effect.Effect<NostrEvent> =>
  makeSignedEvent({
    kind: MUTE_LIST_KIND,
    created_at: createdAtSec,
    tags: pubkeys.map((pubkey) => ["p", pubkey] as const),
    content: "",
  });

const newest10000 = (events: ReadonlyArray<NostrEvent>): NostrEvent =>
  [...events]
    .filter((event) => event.kind === MUTE_LIST_KIND)
    .sort((a, b) => b.created_at - a.created_at)[0]!;

describe("normalizeMutedPubkeys", () => {
  it("trims, lowercases, drops invalid entries, dedups preserving first occurrence", () => {
    expect(
      normalizeMutedPubkeys([
        `  ${PUBKEY_A.toUpperCase()} `,
        PUBKEY_B,
        PUBKEY_A,
        "not-a-pubkey",
        "abc123", // too short
        `${PUBKEY_C}ff`, // too long
        "",
      ]),
    ).toStrictEqual([PUBKEY_A, PUBKEY_B]);
  });
});

describe("npubToPublicKeyHex", () => {
  it("round-trips an encoded npub to its hex pubkey", () => {
    const npub = encodeNip19Key("npub", hexToBytes(PUBKEY_A));
    expect(npubToPublicKeyHex(` ${npub} `)).toBe(PUBKEY_A);
  });

  it("returns null for undecodable input (bad checksum, nsec, garbage)", () => {
    expect(npubToPublicKeyHex("npub1notvalidbech32")).toBeNull();
    expect(npubToPublicKeyHex(encodeNip19Key("nsec", hexToBytes(PUBKEY_A)))).toBeNull();
    expect(npubToPublicKeyHex("")).toBeNull();
    // The dev-seed style fake npubs must be rejected, not mis-decoded.
    expect(npubToPublicKeyHex("npub1strangerstrangerstrangerstrangerstrangerstrangerseed")).toBeNull();
  });
});

describe("mergeMutedPubkeys / muteListTemplate", () => {
  it("unions with existing entries first, additions appended in input order", () => {
    expect(mergeMutedPubkeys([PUBKEY_A, PUBKEY_B], [PUBKEY_B, PUBKEY_C])).toStrictEqual([
      PUBKEY_A,
      PUBKEY_B,
      PUBKEY_C,
    ]);
  });

  it("builds the PoC event shape: p tags only, empty content", () => {
    const template = muteListTemplate([PUBKEY_A, PUBKEY_B], 1_718_001_000);
    expect(template).toStrictEqual({
      kind: MUTE_LIST_KIND,
      created_at: 1_718_001_000,
      tags: [
        ["p", PUBKEY_A],
        ["p", PUBKEY_B],
      ],
      content: "",
    });
  });
});

describe("fetchCurrentMuteList", () => {
  it("reads the newest kind-10000 event's p tags, ignoring foreign tags", async () => {
    await withHarness(
      {
        prepare: (network) =>
          Effect.gen(function* () {
            const relay = yield* network.relay(RELAY);
            const stale = yield* muteListEvent([PUBKEY_C], 1_700_000_000);
            const current = yield* makeSignedEvent({
              kind: MUTE_LIST_KIND,
              created_at: 1_700_000_100,
              tags: [
                ["p", PUBKEY_A],
                ["t", "topic-tag-ignored"],
                ["p", PUBKEY_B],
              ],
              content: "",
            });
            yield* relay.emitEvent(stale);
            yield* relay.emitEvent(current);
          }),
      },
      () =>
        Effect.gen(function* () {
          const identity = yield* derivedIdentity(TEST_SECRET_KEY_HEX);
          const fiber = yield* Effect.fork(
            fetchCurrentMuteList(identity.identity.publicKeyHex, QUERY_WINDOW),
          );
          yield* TestClock.adjust("2 seconds");
          const pubkeys = yield* Fiber.join(fiber);
          // Newest event wins; the stale list's PUBKEY_C is NOT merged in.
          expect(pubkeys).toStrictEqual([PUBKEY_A, PUBKEY_B]);
        }),
    );
  });

  it("returns empty when no relay serves a list within the window", async () => {
    await withHarness({}, () =>
      Effect.gen(function* () {
        const identity = yield* derivedIdentity(TEST_SECRET_KEY_HEX);
        const fiber = yield* Effect.fork(
          fetchCurrentMuteList(identity.identity.publicKeyHex, QUERY_WINDOW),
        );
        yield* TestClock.adjust("2 seconds");
        expect(yield* Fiber.join(fiber)).toStrictEqual([]);
      }),
    );
  });
});

describe("publishMuteList", () => {
  it("merges the new block with existing relay-side entries instead of replacing them", async () => {
    await withHarness(
      {
        prepare: (network) =>
          Effect.gen(function* () {
            const relay = yield* network.relay(RELAY);
            // Entries published earlier (possibly by another client).
            yield* relay.emitEvent(yield* muteListEvent([PUBKEY_A, PUBKEY_B], 1_700_000_000));
          }),
      },
      ({ network }) =>
        Effect.gen(function* () {
          const identity = yield* derivedIdentity(TEST_SECRET_KEY_HEX);
          const result = yield* runPublish(identity, [PUBKEY_C]);

          expect(result.delivery.outcome).toBe("accepted");
          expect(result.existingPubkeys).toStrictEqual([PUBKEY_A, PUBKEY_B]);
          expect(result.mutedPubkeys).toStrictEqual([PUBKEY_A, PUBKEY_B, PUBKEY_C]);

          const relay = yield* network.relay(RELAY);
          const published = newest10000(yield* relay.storedEvents);
          expect(published.id).toBe(result.delivery.event.id);
          expect(mutedPubkeysOfEvent(published)).toStrictEqual([PUBKEY_A, PUBKEY_B, PUBKEY_C]);
          expect(published.content).toBe("");
          expect(published.pubkey).toBe(identity.identity.publicKeyHex);
          expect(verifyNostrEvent(published)).toBe(true);
        }),
    );
  });

  it("re-blocking an already-listed pubkey publishes an unchanged list (idempotent union)", async () => {
    await withHarness(
      {
        prepare: (network) =>
          Effect.gen(function* () {
            const relay = yield* network.relay(RELAY);
            yield* relay.emitEvent(yield* muteListEvent([PUBKEY_A, PUBKEY_B], 1_700_000_000));
          }),
      },
      () =>
        Effect.gen(function* () {
          const identity = yield* derivedIdentity(TEST_SECRET_KEY_HEX);
          const result = yield* runPublish(identity, [PUBKEY_B]);
          expect(result.mutedPubkeys).toStrictEqual([PUBKEY_A, PUBKEY_B]);
        }),
    );
  });

  it("publishes just the local blocklist when no relay-side list exists", async () => {
    await withHarness({}, ({ network }) =>
      Effect.gen(function* () {
        const identity = yield* derivedIdentity(TEST_SECRET_KEY_HEX);
        const result = yield* runPublish(identity, [PUBKEY_C, PUBKEY_A]);

        expect(result.existingPubkeys).toStrictEqual([]);
        expect(result.mutedPubkeys).toStrictEqual([PUBKEY_C, PUBKEY_A]);

        const relay = yield* network.relay(RELAY);
        const published = newest10000(yield* relay.storedEvents);
        expect(published.tags).toStrictEqual([
          ["p", PUBKEY_C],
          ["p", PUBKEY_A],
        ]);
      }),
    );
  });

  it("offline: the merged event is queued, then flushed exactly once on reconnect", async () => {
    await withHarness(
      {
        prepare: (network) =>
          Effect.flatMap(network.relay(RELAY), (relay) => relay.setOnline(false)),
      },
      ({ network }) =>
        Effect.gen(function* () {
          const identity = yield* derivedIdentity(TEST_SECRET_KEY_HEX);
          const queue = yield* NostrPendingQueue;

          // Offline: the fetch comes back empty (local list only) and the
          // pool exhausts its retries, landing the event in the queue.
          const result = yield* runPublish(identity, [PUBKEY_C], "10 seconds");
          expect(result.delivery.outcome).toBe("queued");
          expect(result.existingPubkeys).toStrictEqual([]);
          expect(result.mutedPubkeys).toStrictEqual([PUBKEY_C]);

          const pending = yield* queue.pending;
          expect(pending.map((event) => event.kind)).toStrictEqual([MUTE_LIST_KIND]);

          const relay = yield* network.relay(RELAY);
          expect(yield* relay.publishedEvents).toStrictEqual([]);

          // Reconnect; the standard flush loop delivers the queued list.
          const loop = yield* Effect.fork(runPendingFlushLoop);
          yield* relay.setOnline(true);
          yield* TestClock.adjust("4 seconds");
          yield* awaitCondition(
            Effect.map(relay.storedEvents, (events) => events.length === 1),
            "queued mute list flushed on reconnect",
          );
          expect(yield* queue.pending).toStrictEqual([]);
          const stored = yield* relay.storedEvents;
          expect(stored[0]!.id).toBe(result.delivery.event.id);
          expect(mutedPubkeysOfEvent(stored[0]!)).toStrictEqual([PUBKEY_C]);
          // Exactly once on the wire.
          expect((yield* relay.publishedEvents).length).toBe(1);
          yield* Fiber.interrupt(loop);
        }),
    );
  });
});
