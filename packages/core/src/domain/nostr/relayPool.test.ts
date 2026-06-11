/**
 * RelayPool behavior tests — fake relay network + TestClock, fully
 * deterministic, no real network or timers.
 */
import { Cause, Effect, Exit, Fiber, Layer, Ref, Stream, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";

import type { FakeRelayNetwork } from "./fakeRelay.js";
import { makeFakeRelayNetwork } from "./fakeRelay.js";
import type { NostrEvent } from "./NostrEvent.js";
import type { RelayPoolConfig, RelayPoolService, RelayStatus } from "./RelayPool.js";
import { RelayPool, layerRelayPool } from "./RelayPool.js";
import { awaitCondition, makeSignedEvent, testEnvironmentLayer } from "./nostrTestKit.js";

const RELAY_A = "wss://relay-a.test";
const RELAY_B = "wss://relay-b.test";

/** Fast deterministic policy for tests. */
const testConfig: Partial<RelayPoolConfig> = {
  ackTimeout: "5 seconds",
  publishMaxAttempts: 3,
  publishRetryBaseDelay: "2 seconds",
  publishRetryMaxDelay: "30 seconds",
  reconnectBaseDelay: "1 second",
  reconnectMaxDelay: "8 seconds",
};

const withPool = (
  options: {
    readonly relayUrls?: readonly [string, ...Array<string>];
    readonly config?: Partial<RelayPoolConfig>;
    readonly prepare?: (network: FakeRelayNetwork) => Effect.Effect<void>;
  },
  body: (pool: RelayPoolService, network: FakeRelayNetwork) => Effect.Effect<void, unknown>,
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const network = yield* makeFakeRelayNetwork;
      if (options.prepare) yield* options.prepare(network);
      const poolLayer = layerRelayPool(options.config ?? testConfig).pipe(
        Layer.provide(network.transport),
        Layer.provide(testEnvironmentLayer(options.relayUrls ?? [RELAY_A, RELAY_B])),
      );
      yield* Effect.gen(function* () {
        const pool = yield* RelayPool;
        yield* body(pool, network);
      }).pipe(Effect.provide(poolLayer));
    }).pipe(Effect.provide(TestContext.TestContext)),
  );

const statusOf = (pool: RelayPoolService, url: string) =>
  Effect.map(pool.status, (statuses) => statuses.get(url));

const statusIs = (pool: RelayPoolService, url: string, expected: RelayStatus) =>
  Effect.map(statusOf(pool, url), (status) => status === expected);

const storedIds = (network: FakeRelayNetwork, url: string) =>
  Effect.flatMap(network.relay(url), (relay) =>
    Effect.map(relay.storedEvents, (events) => events.map((event) => event.id)),
  );

describe("relay status", () => {
  it("connects to every configured relay and dedups the relay set", async () => {
    await withPool({ relayUrls: [RELAY_A, RELAY_B, RELAY_A] }, (pool, network) =>
      Effect.gen(function* () {
        expect(pool.relayUrls).toStrictEqual([RELAY_A, RELAY_B]);
        yield* awaitCondition(statusIs(pool, RELAY_A, "connected"), "A connected");
        yield* awaitCondition(statusIs(pool, RELAY_B, "connected"), "B connected");
        const relayA = yield* network.relay(RELAY_A);
        expect(yield* relayA.connectionCount).toBe(1);
      }),
    );
  });

  it("tracks checking -> connected -> disconnected -> connected through a drop", async () => {
    await withPool({}, (pool, network) =>
      Effect.gen(function* () {
        const observed = yield* Ref.make<ReadonlyArray<RelayStatus>>([]);
        const collector = yield* Effect.fork(
          Stream.runForEach(pool.statusChanges, (statuses) =>
            Ref.update(observed, (seen) => {
              const status = statuses.get(RELAY_A);
              return status === undefined || seen[seen.length - 1] === status
                ? seen
                : [...seen, status];
            }),
          ),
        );

        yield* awaitCondition(statusIs(pool, RELAY_A, "connected"), "A connected");
        const relayA = yield* network.relay(RELAY_A);
        yield* relayA.setOnline(false);
        yield* awaitCondition(statusIs(pool, RELAY_A, "disconnected"), "A disconnected");

        // Reconnect attempt after the base delay fails (still offline) ...
        yield* TestClock.adjust("1 second");
        yield* awaitCondition(statusIs(pool, RELAY_A, "disconnected"), "A still down");
        // ... then succeeds once the relay is back.
        yield* relayA.setOnline(true);
        yield* TestClock.adjust("8 seconds");
        yield* awaitCondition(statusIs(pool, RELAY_A, "connected"), "A reconnected");

        const sequence = yield* Ref.get(observed);
        // No flapping: the relay walks through the expected states only.
        expect(sequence.filter((status) => status === "connected").length).toBeGreaterThanOrEqual(
          2,
        );
        expect(sequence).toContain("disconnected");
        for (const status of sequence) {
          expect(["checking", "connected", "disconnected"]).toContain(status);
        }
        yield* Fiber.interrupt(collector);
      }),
    );
  });
});

describe("publish", () => {
  it("succeeds when relays accept and delivers to all of them", async () => {
    await withPool({}, (pool, network) =>
      Effect.gen(function* () {
        yield* awaitCondition(statusIs(pool, RELAY_B, "connected"), "B connected");
        const event = yield* makeSignedEvent({ content: "to everyone" });
        const outcome = yield* pool.publish(event);
        expect(outcome.eventId).toBe(event.id);
        expect(outcome.acceptedBy.length).toBeGreaterThanOrEqual(1);
        yield* awaitCondition(
          Effect.map(storedIds(network, RELAY_A), (ids) => ids.includes(event.id)),
          "A stored",
        );
        yield* awaitCondition(
          Effect.map(storedIds(network, RELAY_B), (ids) => ids.includes(event.id)),
          "B stored",
        );
      }),
    );
  });

  it("succeeds with one relay down, then retries it in background until it accepts", async () => {
    await withPool(
      {
        prepare: (network) =>
          Effect.flatMap(network.relay(RELAY_B), (relay) => relay.setOnline(false)),
      },
      (pool, network) =>
        Effect.gen(function* () {
          yield* awaitCondition(statusIs(pool, RELAY_A, "connected"), "A connected");
          const event = yield* makeSignedEvent({ content: "partial" });

          // Resolves on A's acceptance even though B is down.
          const outcome = yield* pool.publish(event);
          expect(outcome.acceptedBy).toStrictEqual([RELAY_A]);
          expect(yield* storedIds(network, RELAY_B)).toStrictEqual([]);

          // B comes back; its reconnect (1s) lands before the publish retry (2s).
          const relayB = yield* network.relay(RELAY_B);
          yield* relayB.setOnline(true);
          yield* TestClock.adjust("1 second");
          yield* awaitCondition(statusIs(pool, RELAY_B, "connected"), "B reconnected");
          yield* TestClock.adjust("1 second");
          yield* awaitCondition(
            Effect.map(storedIds(network, RELAY_B), (ids) => ids.includes(event.id)),
            "B caught up via background retry",
          );
        }),
    );
  });

  it("treats rejection (OK false) as terminal — no retry, publish fails", async () => {
    await withPool({}, (pool, network) =>
      Effect.gen(function* () {
        yield* awaitCondition(statusIs(pool, RELAY_B, "connected"), "B connected");
        for (const url of [RELAY_A, RELAY_B]) {
          const relay = yield* network.relay(url);
          yield* relay.setPublishResponse({ _tag: "reject", message: "blocked" });
        }
        const event = yield* makeSignedEvent({ content: "rejected" });
        const error = yield* Effect.flip(pool.publish(event));
        expect(error._tag).toBe("NostrPublishError");
        expect(error.eventId).toBe(event.id);
        expect(error.failures.map((failure) => failure.relayUrl).sort()).toStrictEqual([
          RELAY_A,
          RELAY_B,
        ]);
        for (const failure of error.failures) {
          expect(failure.message).toBe("rejected: blocked");
        }
        for (const url of [RELAY_A, RELAY_B]) {
          const relay = yield* network.relay(url);
          // exactly one attempt per relay: rejection is not retried
          expect((yield* relay.publishedEvents).length).toBe(1);
        }
      }),
    );
  });

  it("fails after exhausting attempts when every relay is offline", async () => {
    await withPool(
      {
        prepare: (network) =>
          Effect.forEach(
            [RELAY_A, RELAY_B],
            (url) => Effect.flatMap(network.relay(url), (relay) => relay.setOnline(false)),
            { discard: true },
          ),
      },
      (pool) =>
        Effect.gen(function* () {
          const event = yield* makeSignedEvent({ content: "into the void" });
          const fiber = yield* Effect.fork(Effect.flip(pool.publish(event)));
          // attempts at t=0, +2s, +4s (3 attempts max), then failure
          yield* TestClock.adjust("2 seconds");
          yield* TestClock.adjust("4 seconds");
          const error = yield* Fiber.join(fiber);
          expect(error._tag).toBe("NostrPublishError");
          expect(error.failures).toHaveLength(2);
          for (const failure of error.failures) {
            expect(failure.message).toBe("relay not connected");
          }
        }),
    );
  });

  it("retries after an ack timeout and succeeds once the relay responds", async () => {
    await withPool({ relayUrls: [RELAY_A] }, (pool, network) =>
      Effect.gen(function* () {
        yield* awaitCondition(statusIs(pool, RELAY_A, "connected"), "A connected");
        const relayA = yield* network.relay(RELAY_A);
        yield* relayA.setPublishResponse({ _tag: "silent" });

        const event = yield* makeSignedEvent({ content: "needs patience" });
        const fiber = yield* Effect.fork(pool.publish(event));
        yield* awaitCondition(
          Effect.map(relayA.publishedEvents, (events) => events.length === 1),
          "first attempt sent",
        );

        // First attempt times out (5s), retry is scheduled at +2s.
        yield* TestClock.adjust("5 seconds");
        yield* relayA.setPublishResponse({ _tag: "accept" });
        yield* TestClock.adjust("2 seconds");

        const outcome = yield* Fiber.join(fiber);
        expect(outcome.acceptedBy).toStrictEqual([RELAY_A]);
        expect((yield* relayA.publishedEvents).length).toBe(2);
      }),
    );
  });

  it("dies on an unsigned/tampered event (programmer error)", async () => {
    await withPool({}, (pool) =>
      Effect.gen(function* () {
        const event = yield* makeSignedEvent({ content: "good" });
        const tampered: NostrEvent = { ...event, content: "evil" };
        const exit = yield* Effect.exit(pool.publish(tampered));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.dieOption(exit.cause)._tag).toBe("Some");
        }
      }),
    );
  });
});

describe("subscribe", () => {
  it("dedups by event id across relays and drops invalid signatures", async () => {
    await withPool({}, (pool, network) =>
      Effect.gen(function* () {
        yield* awaitCondition(statusIs(pool, RELAY_A, "connected"), "A connected");
        yield* awaitCondition(statusIs(pool, RELAY_B, "connected"), "B connected");

        const received = yield* Ref.make<ReadonlyArray<NostrEvent>>([]);
        const consumer = yield* Effect.fork(
          Stream.runForEach(pool.subscribe([{ kinds: [1] }]), (event) =>
            Ref.update(received, (events) => [...events, event]),
          ),
        );

        const relayA = yield* network.relay(RELAY_A);
        const relayB = yield* network.relay(RELAY_B);
        const eventOne = yield* makeSignedEvent({ content: "one", created_at: 1_718_000_001 });
        const eventTwo = yield* makeSignedEvent({ content: "two", created_at: 1_718_000_002 });
        const forged: NostrEvent = { ...eventTwo, sig: "0".repeat(128) };

        // Same event from both relays -> one delivery.
        yield* relayA.emitEvent(eventOne);
        yield* relayB.emitEvent(eventOne);
        // Forged event (valid shape, bad sig) -> dropped.
        yield* relayA.emitEvent(forged);
        // Different event -> delivered.
        yield* relayB.emitEvent(eventTwo);

        yield* awaitCondition(
          Effect.map(Ref.get(received), (events) =>
            events.some((event) => event.id === eventTwo.id),
          ),
          "second event received",
        );
        const events = yield* Ref.get(received);
        expect(events.map((event) => event.id)).toStrictEqual([eventOne.id, eventTwo.id]);
        yield* Fiber.interrupt(consumer);
      }),
    );
  });

  it("re-issues the REQ after a reconnect without duplicating replayed events", async () => {
    await withPool({ relayUrls: [RELAY_A] }, (pool, network) =>
      Effect.gen(function* () {
        yield* awaitCondition(statusIs(pool, RELAY_A, "connected"), "A connected");
        const relayA = yield* network.relay(RELAY_A);

        const received = yield* Ref.make<ReadonlyArray<NostrEvent>>([]);
        const consumer = yield* Effect.fork(
          Stream.runForEach(pool.subscribe([{ kinds: [1] }]), (event) =>
            Ref.update(received, (events) => [...events, event]),
          ),
        );

        const eventOne = yield* makeSignedEvent({ content: "before drop" });
        yield* relayA.emitEvent(eventOne);
        yield* awaitCondition(
          Effect.map(Ref.get(received), (events) => events.length === 1),
          "event before drop",
        );

        yield* relayA.setOnline(false);
        yield* awaitCondition(statusIs(pool, RELAY_A, "disconnected"), "A down");
        yield* relayA.setOnline(true);
        yield* TestClock.adjust("1 second");
        yield* awaitCondition(statusIs(pool, RELAY_A, "connected"), "A back");

        // The re-issued REQ replays eventOne from the relay store — the
        // pool must dedup it. A genuinely new event still arrives.
        const eventTwo = yield* makeSignedEvent({ content: "after reconnect" });
        yield* relayA.emitEvent(eventTwo);
        yield* awaitCondition(
          Effect.map(Ref.get(received), (events) =>
            events.some((event) => event.id === eventTwo.id),
          ),
          "event after reconnect",
        );
        const events = yield* Ref.get(received);
        expect(events.map((event) => event.id)).toStrictEqual([eventOne.id, eventTwo.id]);
        yield* Fiber.interrupt(consumer);
      }),
    );
  });
});
