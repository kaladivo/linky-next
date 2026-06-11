/**
 * Relay list publishing tests (issue #23) — both kinds with PoC tag shapes,
 * replaceability via `created_at`, the offline → queued → flushed path, and
 * the custom-key identity (#20) signing when active. Fake relay network +
 * TestClock; fully deterministic.
 */
import { Effect, Fiber, Layer, Option, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";

import { KeyValueStorage } from "../../ports/KeyValueStorage.js";
import type { Randomness } from "../../ports/Randomness.js";
import { SecureStorage } from "../../ports/SecureStorage.js";
import type { ActiveNostrIdentity } from "../identity/customNostrKey.js";
import {
  activateCustomNostrKey,
  nostrIdentityFromNsec,
  resolveActiveNostrIdentity,
} from "../identity/customNostrKey.js";
import { encodeNip19Key } from "../identity/nip19.js";
import type { FakeRelayNetwork } from "./fakeRelay.js";
import { makeFakeRelayNetwork } from "./fakeRelay.js";
import type { NostrEvent } from "./NostrEvent.js";
import { verifyNostrEvent } from "./NostrEvent.js";
import { NostrPendingQueue, layerNostrPendingQueue, runPendingFlushLoop } from "./NostrPendingQueue.js";
import type { RelayPool, RelayPoolConfig } from "./RelayPool.js";
import { layerRelayPool } from "./RelayPool.js";
import {
  INBOX_RELAY_LIST_KIND,
  RELAY_LIST_KIND,
  normalizeRelayUrls,
  publishCurrentRelayLists,
  publishRelayLists,
} from "./relayLists.js";
import {
  RandomnessFixed,
  TEST_SECRET_KEY_HEX,
  awaitCondition,
  hexToBytes,
  testEnvironmentLayer,
} from "./nostrTestKit.js";

const RELAY = "wss://relay-lists.test";

/** A second throwaway scalar for the custom-key test. Never a real identity. */
const CUSTOM_SECRET_KEY_HEX = "1111111111111111111111111111111111111111111111111111111111111111";

const FIXED_MS = 1_720_000_000_000;
const FIXED_SEC = 1_720_000_000;

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

const byKind = (events: ReadonlyArray<NostrEvent>, kind: number): ReadonlyArray<NostrEvent> =>
  events.filter((event) => event.kind === kind);

const newestOfKind = (events: ReadonlyArray<NostrEvent>, kind: number): NostrEvent =>
  [...byKind(events, kind)].sort((a, b) => b.created_at - a.created_at)[0]!;

describe("normalizeRelayUrls", () => {
  it("trims, drops empties, dedups preserving first occurrence (PoC behavior)", () => {
    expect(
      normalizeRelayUrls([
        "  wss://a.test ",
        "wss://b.test",
        "wss://a.test",
        "   ",
        "wss://c.test",
        "wss://b.test  ",
      ]),
    ).toStrictEqual(["wss://a.test", "wss://b.test", "wss://c.test"]);
  });
});

describe("publishRelayLists", () => {
  it("publishes kind 10002 (r tags) and kind 10050 (relay tags) for the relay set", async () => {
    await withHarness({}, ({ network }) =>
      Effect.gen(function* () {
        const identity = yield* derivedIdentity(TEST_SECRET_KEY_HEX);
        const result = yield* publishRelayLists(identity, {
          relayUrls: [" wss://a.test ", "wss://b.test", "wss://a.test"],
        });

        expect(result.relayList.outcome).toBe("accepted");
        expect(result.inboxRelayList.outcome).toBe("accepted");

        const relay = yield* network.relay(RELAY);
        const stored = yield* relay.storedEvents;
        expect(stored).toHaveLength(2);

        const relayList = newestOfKind(stored, RELAY_LIST_KIND);
        expect(relayList.tags).toStrictEqual([
          ["r", "wss://a.test"],
          ["r", "wss://b.test"],
        ]);
        expect(relayList.content).toBe("");
        expect(relayList.created_at).toBe(FIXED_SEC);
        expect(relayList.pubkey).toBe(identity.identity.publicKeyHex);
        expect(verifyNostrEvent(relayList)).toBe(true);

        const inboxList = newestOfKind(stored, INBOX_RELAY_LIST_KIND);
        expect(inboxList.tags).toStrictEqual([
          ["relay", "wss://a.test"],
          ["relay", "wss://b.test"],
        ]);
        expect(inboxList.content).toBe("");
        expect(inboxList.created_at).toBe(FIXED_SEC);
        expect(inboxList.pubkey).toBe(identity.identity.publicKeyHex);
        expect(verifyNostrEvent(inboxList)).toBe(true);
      }),
    );
  });

  it("re-publishing is replaceable-safe: newer created_at wins, same-second rerun is identical", async () => {
    await withHarness({}, ({ network }) =>
      Effect.gen(function* () {
        const identity = yield* derivedIdentity(TEST_SECRET_KEY_HEX);
        const first = yield* publishRelayLists(identity, { relayUrls: ["wss://old.test"] });

        // Same second, same settings -> the very same event ids (relay no-op).
        const rerun = yield* publishRelayLists(identity, { relayUrls: ["wss://old.test"] });
        expect(rerun.relayList.event.id).toBe(first.relayList.event.id);
        expect(rerun.inboxRelayList.event.id).toBe(first.inboxRelayList.event.id);

        // Later settings change -> strictly newer created_at, so relays
        // replace the old list (both kinds are replaceable, no d tag).
        yield* TestClock.adjust("90 seconds");
        const second = yield* publishRelayLists(identity, { relayUrls: ["wss://new.test"] });
        expect(second.relayList.event.created_at).toBeGreaterThan(
          first.relayList.event.created_at,
        );

        const relay = yield* network.relay(RELAY);
        const stored = yield* relay.storedEvents;
        const newest10002 = newestOfKind(stored, RELAY_LIST_KIND);
        expect(newest10002.id).toBe(second.relayList.event.id);
        expect(newest10002.tags).toStrictEqual([["r", "wss://new.test"]]);
        const newest10050 = newestOfKind(stored, INBOX_RELAY_LIST_KIND);
        expect(newest10050.id).toBe(second.inboxRelayList.event.id);
        expect(newest10050.tags).toStrictEqual([["relay", "wss://new.test"]]);
      }),
    );
  });

  it("offline: both events are queued, then flushed exactly once on reconnect", async () => {
    await withHarness(
      {
        prepare: (network) =>
          Effect.flatMap(network.relay(RELAY), (relay) => relay.setOnline(false)),
      },
      ({ network }) =>
        Effect.gen(function* () {
          const identity = yield* derivedIdentity(TEST_SECRET_KEY_HEX);
          const queue = yield* NostrPendingQueue;

          // Publish while offline: the pool exhausts its retries (2 attempts,
          // 1s backoff), then both events land in the pending queue.
          const publishFiber = yield* Effect.fork(
            publishRelayLists(identity, { relayUrls: ["wss://a.test"] }),
          );
          yield* TestClock.adjust("10 seconds");
          const result = yield* Fiber.join(publishFiber);
          expect(result.relayList.outcome).toBe("queued");
          expect(result.inboxRelayList.outcome).toBe("queued");

          const pending = yield* queue.pending;
          expect(pending.map((event) => event.kind).sort()).toStrictEqual([
            RELAY_LIST_KIND,
            INBOX_RELAY_LIST_KIND,
          ]);

          // Nothing reached the relay while offline.
          const relay = yield* network.relay(RELAY);
          expect(yield* relay.publishedEvents).toStrictEqual([]);

          // Reconnect; the standard flush loop delivers the queued lists.
          const loop = yield* Effect.fork(runPendingFlushLoop);
          yield* relay.setOnline(true);
          yield* TestClock.adjust("4 seconds");
          yield* awaitCondition(
            Effect.map(relay.storedEvents, (events) => events.length === 2),
            "queued relay lists flushed on reconnect",
          );
          expect(yield* queue.pending).toStrictEqual([]);
          const storedIds = (yield* relay.storedEvents).map((event) => event.id).sort();
          expect(storedIds).toStrictEqual(
            [result.relayList.event.id, result.inboxRelayList.event.id].sort(),
          );
          // Exactly once on the wire.
          expect((yield* relay.publishedEvents).length).toBe(2);
          yield* Fiber.interrupt(loop);
        }),
    );
  });

  it("signs with the custom-key identity when one is active (#20)", async () => {
    const SecureStorageMemory = Layer.sync(SecureStorage, () => {
      const store = new Map<string, string>();
      return {
        get: (key: string) => Effect.sync(() => Option.fromNullable(store.get(key))),
        set: (key: string, value: string) => Effect.sync(() => void store.set(key, value)),
        delete: (key: string) => Effect.sync(() => void store.delete(key)),
      };
    });

    await withHarness({}, ({ network }) =>
      Effect.gen(function* () {
        const derived = yield* derivedIdentity(TEST_SECRET_KEY_HEX);

        const active = yield* Effect.gen(function* () {
          yield* activateCustomNostrKey(encodeNip19Key("nsec", hexToBytes(CUSTOM_SECRET_KEY_HEX)));
          return yield* resolveActiveNostrIdentity(derived.identity);
        }).pipe(Effect.provide(SecureStorageMemory), Effect.orDie);
        expect(active.source).toBe("custom");
        expect(active.identity.publicKeyHex).not.toBe(derived.identity.publicKeyHex);

        yield* publishRelayLists(active, { relayUrls: ["wss://a.test"] });

        const relay = yield* network.relay(RELAY);
        const stored = yield* relay.storedEvents;
        expect(stored).toHaveLength(2);
        for (const event of stored) {
          expect(event.pubkey).toBe(active.identity.publicKeyHex);
          expect(verifyNostrEvent(event)).toBe(true);
        }
      }),
    );
  });
});

describe("publishCurrentRelayLists (startup sync)", () => {
  it("announces the configured relay set from CurrentEnvironment", async () => {
    await withHarness({}, ({ network }) =>
      Effect.gen(function* () {
        const identity = yield* derivedIdentity(TEST_SECRET_KEY_HEX);
        yield* publishCurrentRelayLists(identity).pipe(
          Effect.provide(testEnvironmentLayer([RELAY])),
        );

        const relay = yield* network.relay(RELAY);
        const stored = yield* relay.storedEvents;
        expect(newestOfKind(stored, RELAY_LIST_KIND).tags).toStrictEqual([["r", RELAY]]);
        expect(newestOfKind(stored, INBOX_RELAY_LIST_KIND).tags).toStrictEqual([["relay", RELAY]]);
      }),
    );
  });
});
