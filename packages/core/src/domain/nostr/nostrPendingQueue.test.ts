/**
 * NostrPendingQueue tests — persistence round-trips through the in-memory
 * KeyValueStore, flush semantics against the fake relay network, TestClock
 * for the offline retry policy.
 */
import { Effect, Fiber, Layer, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";

import { KeyValueStorage } from "../../ports/KeyValueStorage.js";
import type { FakeRelayNetwork } from "./fakeRelay.js";
import { makeFakeRelayNetwork } from "./fakeRelay.js";
import type { NostrEvent } from "./NostrEvent.js";
import type { NostrPendingQueueService } from "./NostrPendingQueue.js";
import {
  NostrPendingQueue,
  PENDING_EVENTS_STORAGE_KEY,
  layerNostrPendingQueue,
  makeNostrPendingQueue,
  runPendingFlushLoop,
} from "./NostrPendingQueue.js";
import type { RelayPoolConfig, RelayPoolService } from "./RelayPool.js";
import { RelayPool, layerRelayPool } from "./RelayPool.js";
import { awaitCondition, makeSignedEvent, testEnvironmentLayer } from "./nostrTestKit.js";

const RELAY = "wss://relay-q.test";

const testConfig: Partial<RelayPoolConfig> = {
  ackTimeout: "5 seconds",
  publishMaxAttempts: 2,
  publishRetryBaseDelay: "1 second",
  reconnectBaseDelay: "1 second",
  reconnectMaxDelay: "4 seconds",
};

interface Harness {
  readonly network: FakeRelayNetwork;
  readonly pool: RelayPoolService;
  readonly queue: NostrPendingQueueService;
}

/**
 * Builds pool + queue over one fake network and one in-memory KV store.
 * The KV store and pool live for the whole test, so a second queue service
 * built with `makeNostrPendingQueue` inside `body` simulates an app restart
 * over the same persisted state.
 */
const withQueue = (
  options: { readonly prepare?: (network: FakeRelayNetwork) => Effect.Effect<void> },
  body: (
    harness: Harness,
  ) => Effect.Effect<void, unknown, KeyValueStorage.KeyValueStore | RelayPool>,
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const network = yield* makeFakeRelayNetwork;
      if (options.prepare) yield* options.prepare(network);
      const poolLayer = layerRelayPool(testConfig).pipe(
        Layer.provide(network.transport),
        Layer.provide(testEnvironmentLayer([RELAY])),
      );
      yield* Effect.gen(function* () {
        const pool = yield* RelayPool;
        const queue = yield* makeNostrPendingQueue;
        yield* body({ network, pool, queue });
      }).pipe(Effect.provide([poolLayer, KeyValueStorage.layerMemory]));
    }).pipe(Effect.provide(TestContext.TestContext)),
  );

const eventIds = (events: ReadonlyArray<NostrEvent>): ReadonlyArray<string> =>
  events.map((event) => event.id);

const threeEvents = Effect.all([
  makeSignedEvent({ content: "first", created_at: 1_718_000_001 }),
  makeSignedEvent({ content: "second", created_at: 1_718_000_002 }),
  makeSignedEvent({ content: "third", created_at: 1_718_000_003 }),
]);

describe("enqueue / pending / persistence", () => {
  it("is idempotent by event id and keeps enqueue order", async () => {
    await withQueue({}, ({ queue }) =>
      Effect.gen(function* () {
        const [first, second] = yield* threeEvents;
        yield* queue.enqueue(first);
        yield* queue.enqueue(second);
        yield* queue.enqueue(first); // duplicate id -> no-op
        expect(eventIds(yield* queue.pending)).toStrictEqual([first.id, second.id]);
      }),
    );
  });

  it("survives a restart: a second service instance over the same store sees the queue", async () => {
    await withQueue({}, ({ queue }) =>
      Effect.gen(function* () {
        const [first, second] = yield* threeEvents;
        yield* queue.enqueue(first);
        yield* queue.enqueue(second);

        // "Restart": fresh service over the same KeyValueStore.
        const reborn = yield* makeNostrPendingQueue;
        expect(eventIds(yield* reborn.pending)).toStrictEqual([first.id, second.id]);

        // And the restarted instance can flush what the old one queued.
        const outcome = yield* reborn.flush;
        expect(outcome.sentEventIds).toStrictEqual([first.id, second.id]);
        expect(yield* reborn.pending).toStrictEqual([]);
      }),
    );
  });

  it("removes events by id", async () => {
    await withQueue({}, ({ queue }) =>
      Effect.gen(function* () {
        const [first, second] = yield* threeEvents;
        yield* queue.enqueue(first);
        yield* queue.enqueue(second);
        yield* queue.remove(first.id);
        expect(eventIds(yield* queue.pending)).toStrictEqual([second.id]);
      }),
    );
  });

  it("surfaces corrupted storage as a typed load error", async () => {
    await withQueue({}, ({ queue }) =>
      Effect.gen(function* () {
        const kv = yield* KeyValueStorage.KeyValueStore;
        yield* kv.set(PENDING_EVENTS_STORAGE_KEY, "this is not a queue");
        const error = yield* Effect.flip(queue.pending);
        expect(error._tag).toBe("NostrPendingQueueError");
        expect(error.operation).toBe("load");
      }),
    );
  });
});

describe("flush", () => {
  it("publishes queued events in order and drains the queue", async () => {
    await withQueue({}, ({ network, queue }) =>
      Effect.gen(function* () {
        const [first, second, third] = yield* threeEvents;
        yield* queue.enqueue(first);
        yield* queue.enqueue(second);
        yield* queue.enqueue(third);

        const outcome = yield* queue.flush;
        expect(outcome.sentEventIds).toStrictEqual([first.id, second.id, third.id]);
        expect(outcome.remainingEventIds).toStrictEqual([]);
        expect(yield* queue.pending).toStrictEqual([]);

        const relay = yield* network.relay(RELAY);
        // Order preserved on the wire, nothing sent twice.
        expect(eventIds(yield* relay.publishedEvents)).toStrictEqual([
          first.id,
          second.id,
          third.id,
        ]);
      }),
    );
  });

  it("keeps rejected events queued and still sends the rest (partial success)", async () => {
    await withQueue({}, ({ network, queue }) =>
      Effect.gen(function* () {
        const [first, second, third] = yield* threeEvents;
        const relay = yield* network.relay(RELAY);
        yield* relay.setPublishResponse((event) =>
          event.id === second.id ? { _tag: "reject", message: "nope" } : { _tag: "accept" },
        );

        yield* queue.enqueue(first);
        yield* queue.enqueue(second);
        yield* queue.enqueue(third);

        const outcome = yield* queue.flush;
        expect(outcome.sentEventIds).toStrictEqual([first.id, third.id]);
        expect(outcome.remainingEventIds).toStrictEqual([second.id]);
        expect(eventIds(yield* queue.pending)).toStrictEqual([second.id]);
      }),
    );
  });

  it("tolerates full offline: nothing lost, later flush sends everything exactly once", async () => {
    await withQueue(
      {
        prepare: (network) =>
          Effect.flatMap(network.relay(RELAY), (relay) => relay.setOnline(false)),
      },
      ({ network, pool, queue }) =>
        Effect.gen(function* () {
          const [first, second] = yield* threeEvents;
          yield* queue.enqueue(first);
          yield* queue.enqueue(second);

          // Offline flush: each publish exhausts its 2 attempts (t+1s retry).
          const flushFiber = yield* Effect.fork(queue.flush);
          yield* TestClock.adjust("10 seconds");
          const offlineOutcome = yield* Fiber.join(flushFiber);
          expect(offlineOutcome.sentEventIds).toStrictEqual([]);
          expect(offlineOutcome.remainingEventIds).toStrictEqual([first.id, second.id]);
          expect(eventIds(yield* queue.pending)).toStrictEqual([first.id, second.id]);

          // Back online; reconnect happens on the loop's next attempt.
          const relay = yield* network.relay(RELAY);
          yield* relay.setOnline(true);
          yield* TestClock.adjust("4 seconds");
          yield* awaitCondition(
            Effect.map(pool.status, (statuses) => statuses.get(RELAY) === "connected"),
            "relay reconnected",
          );

          const outcome = yield* queue.flush;
          expect(outcome.sentEventIds).toStrictEqual([first.id, second.id]);
          expect(yield* queue.pending).toStrictEqual([]);
          // No duplicates ever reached the relay: offline sends never left the client.
          expect(eventIds(yield* relay.publishedEvents)).toStrictEqual([first.id, second.id]);
        }),
    );
  });
});

describe("runPendingFlushLoop", () => {
  it("flushes on start when connected and again after a reconnect", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const network = yield* makeFakeRelayNetwork;
        const poolLayer = layerRelayPool(testConfig).pipe(
          Layer.provide(network.transport),
          Layer.provide(testEnvironmentLayer([RELAY])),
        );
        const queueLayer = layerNostrPendingQueue.pipe(
          Layer.provideMerge(poolLayer),
          Layer.provideMerge(KeyValueStorage.layerMemory),
        );
        yield* Effect.gen(function* () {
          const pool = yield* RelayPool;
          const queue = yield* NostrPendingQueue;
          const relay = yield* network.relay(RELAY);

          const [first, second] = yield* threeEvents;
          yield* queue.enqueue(first);
          const loop = yield* Effect.fork(runPendingFlushLoop);

          // App start while online: the replayed status triggers a flush.
          yield* awaitCondition(
            Effect.map(relay.storedEvents, (events) => eventIds(events).includes(first.id)),
            "flushed on start",
          );

          // Go offline, queue more work, come back: reconnect triggers a flush.
          yield* relay.setOnline(false);
          yield* awaitCondition(
            Effect.map(pool.status, (statuses) => statuses.get(RELAY) === "disconnected"),
            "offline observed",
          );
          yield* queue.enqueue(second);
          yield* relay.setOnline(true);
          yield* TestClock.adjust("4 seconds");
          yield* awaitCondition(
            Effect.map(relay.storedEvents, (events) => eventIds(events).includes(second.id)),
            "flushed on reconnect",
          );
          expect(yield* queue.pending).toStrictEqual([]);
          yield* Fiber.interrupt(loop);
        }).pipe(Effect.provide(queueLayer));
      }).pipe(Effect.provide(TestContext.TestContext)),
    );
  });
});

describe("flush concurrency", () => {
  it("serializes concurrent flushes (single flight, no double sends)", async () => {
    await withQueue({}, ({ network, queue }) =>
      Effect.gen(function* () {
        const [first, second] = yield* threeEvents;
        yield* queue.enqueue(first);
        yield* queue.enqueue(second);

        const [left, right] = yield* Effect.all([queue.flush, queue.flush], {
          concurrency: 2,
        });
        const sentTotal = [...left.sentEventIds, ...right.sentEventIds];
        expect(sentTotal.sort()).toStrictEqual([first.id, second.id].sort());

        const relay = yield* network.relay(RELAY);
        expect([...eventIds(yield* relay.publishedEvents)].sort()).toStrictEqual(
          [first.id, second.id].sort(),
        );
      }),
    );
  });
});
