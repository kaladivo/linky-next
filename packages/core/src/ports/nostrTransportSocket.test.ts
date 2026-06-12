/**
 * layerNostrTransportSocket tests — the WebSocket-backed transport driven by
 * a scripted fake `WebSocketConstructor` (no network, TestClock for the open
 * timeout), mirroring how `packages/platform` adapters are tested with fakes.
 */
import { Socket } from "@effect/platform";
import { Chunk, Effect, Fiber, Layer, Option, Ref, Stream, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";

import type { NostrRelaySocket, NostrTransportService } from "./NostrTransport.js";
import { NostrTransport, layerNostrTransportSocket } from "./NostrTransport.js";
import { RelayPool, layerRelayPool } from "../domain/nostr/RelayPool.js";
import { testEnvironmentLayer } from "../domain/nostr/nostrTestKit.js";

// ---------------------------------------------------------------------------
// Scripted WebSocket fake (the surface @effect/platform's Socket touches)
// ---------------------------------------------------------------------------

type Listener = { readonly fn: (event: unknown) => void; readonly once: boolean };

class FakeWebSocket {
  readyState = 0;
  readonly sent: Array<unknown> = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string) {}

  addEventListener(type: string, fn: (event: unknown) => void, opts?: { once?: boolean }): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add({ fn, once: opts?.once === true });
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, fn: (event: unknown) => void): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const listener of set) if (listener.fn === fn) set.delete(listener);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push(
      code === undefined ? {} : { code, ...(reason === undefined ? {} : { reason }) },
    );
  }

  /** Test driver: fire an event at registered listeners. */
  emit(type: string, event: unknown): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const listener of [...set]) {
      if (listener.once) set.delete(listener);
      listener.fn(event);
    }
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }
}

const makeHarness = Effect.sync(() => {
  const created: Array<FakeWebSocket> = [];
  const constructorLayer = Layer.succeed(Socket.WebSocketConstructor, (url) => {
    const ws = new FakeWebSocket(url);
    created.push(ws);
    return ws as unknown as globalThis.WebSocket;
  });
  return { created, constructorLayer };
});

/** Yields until the constructor has produced `count` sockets. */
const awaitSockets = (created: Array<FakeWebSocket>, count: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < 5_000; i += 1) {
      if (created.length >= count) return;
      yield* Effect.yieldNow();
    }
    return yield* Effect.die(new Error("fake websocket was never constructed"));
  });

const run = <E>(effect: Effect.Effect<void, E>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestContext.TestContext)));

const withTransport = (
  body: (
    transport: NostrTransportService,
    created: Array<FakeWebSocket>,
  ) => Effect.Effect<void, unknown>,
) =>
  run(
    Effect.gen(function* () {
      const { created, constructorLayer } = yield* makeHarness;
      yield* Effect.gen(function* () {
        const transport = yield* NostrTransport;
        yield* body(transport, created);
      }).pipe(
        Effect.provide(
          layerNostrTransportSocket({ openTimeout: "10 seconds" }).pipe(
            Layer.provide(constructorLayer),
          ),
        ),
      );
    }),
  );

const RELAY_URL = "wss://relay.test";

describe("layerNostrTransportSocket", () => {
  it("connects on open, pumps frames in, sends frames out, ends cleanly on close", async () => {
    await withTransport((transport, created) =>
      Effect.scoped(
        Effect.gen(function* () {
          const connecting = yield* Effect.fork(transport.connect(RELAY_URL));
          yield* awaitSockets(created, 1);
          const ws = created[0]!;
          ws.open();
          const socket: NostrRelaySocket = yield* Fiber.join(connecting);

          // inbound frames
          const collected = yield* Ref.make<ReadonlyArray<string>>([]);
          const consumer = yield* Effect.fork(
            Stream.runForEach(socket.frames, (frame) =>
              Ref.update(collected, (frames) => [...frames, frame]),
            ),
          );
          ws.emit("message", { data: '["NOTICE","hello"]' });
          ws.emit("message", { data: '["EOSE","sub"]' });
          // binary frames are ignored (Nostr is text-only)
          ws.emit("message", { data: new Uint8Array([1, 2, 3]) });

          // outbound frames
          yield* socket.send('["REQ","sub",{}]');
          expect(ws.sent).toStrictEqual(['["REQ","sub",{}]']);

          // clean close ends the frames stream (no error)
          ws.emit("close", { code: 1000, reason: "done" });
          yield* Fiber.join(consumer);
          expect(yield* Ref.get(collected)).toStrictEqual(['["NOTICE","hello"]', '["EOSE","sub"]']);

          // sending after close fails with a typed transport error
          const error = yield* Effect.flip(socket.send("late"));
          expect(error._tag).toBe("NostrTransportError");
          expect(error.reason).toBe("closed");
        }),
      ),
    );
  });

  it("fails connect with reason 'connect' when the socket errors before opening", async () => {
    await withTransport((transport, created) =>
      Effect.scoped(
        Effect.gen(function* () {
          const connecting = yield* Effect.fork(Effect.flip(transport.connect(RELAY_URL)));
          yield* awaitSockets(created, 1);
          created[0]!.emit("error", new Error("ECONNREFUSED"));
          const error = yield* Fiber.join(connecting);
          expect(error._tag).toBe("NostrTransportError");
          expect(error.reason).toBe("connect");
          expect(error.relayUrl).toBe(RELAY_URL);
        }),
      ),
    );
  });

  it("fails connect with reason 'connect' on open timeout (TestClock)", async () => {
    await withTransport((transport, created) =>
      Effect.scoped(
        Effect.gen(function* () {
          const connecting = yield* Effect.fork(Effect.flip(transport.connect(RELAY_URL)));
          yield* awaitSockets(created, 1);
          // never emit "open"
          yield* TestClock.adjust("10 seconds");
          const error = yield* Fiber.join(connecting);
          expect(error._tag).toBe("NostrTransportError");
          expect(error.reason).toBe("connect");
        }),
      ),
    );
  });

  it("fails the frames stream when the connection drops uncleanly", async () => {
    await withTransport((transport, created) =>
      Effect.scoped(
        Effect.gen(function* () {
          const connecting = yield* Effect.fork(transport.connect(RELAY_URL));
          yield* awaitSockets(created, 1);
          const ws = created[0]!;
          ws.open();
          const socket = yield* Fiber.join(connecting);

          const consumer = yield* Effect.fork(Effect.flip(Stream.runCollect(socket.frames)));
          ws.emit("message", { data: "frame-1" });
          ws.emit("close", { code: 1011, reason: "server exploded" });
          const error = yield* Fiber.join(consumer);
          expect(error._tag).toBe("NostrTransportError");
          expect(error.reason).toBe("closed");
        }),
      ),
    );
  });

  it("send completes inside an uninterruptible region (#28 regression)", async () => {
    // Scope finalizers run with interruption masked. `send` races the write
    // against connection death, and a race can only settle by interrupting
    // its parked loser — under the mask that interruption was impossible, so
    // every RelayPool unsubscribe (CLOSE in a finalizer) hung on a healthy
    // connection. Pinned here at the primitive level.
    await withTransport((transport, created) =>
      Effect.scoped(
        Effect.gen(function* () {
          const connecting = yield* Effect.fork(transport.connect(RELAY_URL));
          yield* awaitSockets(created, 1);
          const ws = created[0]!;
          ws.open();
          const socket = yield* Fiber.join(connecting);

          const sender = yield* Effect.fork(
            Effect.uninterruptible(socket.send('["CLOSE","sub-1"]')),
          );
          // Cooperative wait (no clock): the send must settle on its own.
          let settled = false;
          for (let i = 0; i < 5_000 && !settled; i += 1) {
            settled = Option.isSome(yield* Fiber.poll(sender));
            if (!settled) yield* Effect.yieldNow();
          }
          if (!settled) return yield* Effect.die(new Error("uninterruptible send hung"));
          expect(ws.sent).toStrictEqual(['["CLOSE","sub-1"]']);
        }),
      ),
    );
  });

  it("RelayPool unsubscribe over the socket transport finishes promptly (#28 regression)", async () => {
    // The device-observed hang: interrupting a `RelayPool.subscribe`
    // consumer (the `Stream.interruptAfter` window every fetch uses) never
    // completed, because the unsubscribe finalizer's CLOSE send blocked on
    // the transport's uninterruptible race. fakeRelay never reproduced it —
    // its `send` is synchronous — so this pins pool + REAL socket transport.
    await run(
      Effect.gen(function* () {
        const { created, constructorLayer } = yield* makeHarness;
        const poolLayer = layerRelayPool().pipe(
          Layer.provide(
            layerNostrTransportSocket({ openTimeout: "10 seconds" }).pipe(
              Layer.provide(constructorLayer),
            ),
          ),
          Layer.provide(testEnvironmentLayer([RELAY_URL])),
        );

        yield* Effect.gen(function* () {
          const pool = yield* RelayPool;
          yield* awaitSockets(created, 1);
          const ws = created[0]!;
          ws.open();

          // Wait for the pool to register the connection.
          for (let i = 0; i < 5_000; i += 1) {
            const status = yield* pool.status;
            if (status.get(RELAY_URL) === "connected") break;
            yield* Effect.yieldNow();
          }

          const consumer = yield* Effect.fork(
            pool
              .subscribe([{ kinds: [0], limit: 1 }])
              .pipe(Stream.interruptAfter("2 seconds"), Stream.runCount),
          );

          // The REQ goes out on the wire first.
          for (let i = 0; i < 5_000; i += 1) {
            if (ws.sent.some((frame) => String(frame).startsWith('["REQ"'))) break;
            yield* Effect.yieldNow();
          }
          expect(ws.sent.some((frame) => String(frame).startsWith('["REQ"'))).toBe(true);

          // Window elapses -> the consumer MUST complete (this hung before).
          yield* TestClock.adjust("2 seconds");
          const count = yield* Fiber.join(consumer);
          expect(count).toBe(0);

          // The advisory CLOSE still reaches the relay (pool-scoped fiber).
          let closed = false;
          for (let i = 0; i < 5_000 && !closed; i += 1) {
            closed = ws.sent.some((frame) => String(frame).startsWith('["CLOSE"'));
            if (!closed) yield* Effect.yieldNow();
          }
          expect(closed).toBe(true);
        }).pipe(Effect.provide(poolLayer));
      }),
    );
  });

  it("delivers buffered frames before reporting the unclean close", async () => {
    await withTransport((transport, created) =>
      Effect.scoped(
        Effect.gen(function* () {
          const connecting = yield* Effect.fork(transport.connect(RELAY_URL));
          yield* awaitSockets(created, 1);
          const ws = created[0]!;
          ws.open();
          const socket = yield* Fiber.join(connecting);

          ws.emit("message", { data: "frame-1" });
          ws.emit("close", { code: 1006, reason: "dropped" });

          const taken = yield* Stream.runCollect(socket.frames.pipe(Stream.take(1)));
          expect(Chunk.toReadonlyArray(taken)).toStrictEqual(["frame-1"]);
        }),
      ),
    );
  });
});
