/**
 * NostrPendingQueue — a persistent outbox of signed-but-unsent Nostr events
 * (chat, payments, profile), `nostr.pending-flush` in the feature map.
 *
 * Events are persisted through the `KeyValueStorage` port (serialized JSON
 * under `linky.nostr.pendingEvents.v1`), so the queue survives app
 * restarts. The contract:
 *
 * - **Idempotent by event id** — enqueueing an already-queued id is a no-op;
 *   a flush never sends the same queued event twice (republishing an id a
 *   relay already has is harmless on the Nostr side).
 * - **Flush in order** — events are attempted oldest-first (enqueue order).
 *   An event is removed only after the pool reports ≥ 1 relay accepted it;
 *   failures stay queued and later events are still attempted (partial
 *   success, PoC behavior).
 * - **Offline tolerant** — with all relays down every publish fails after
 *   the pool's retry policy and the whole queue simply remains for the next
 *   flush. Flushes are single-flight (concurrent callers serialize).
 *
 * `runPendingFlushLoop` is the standard trigger wiring: it flushes whenever
 * the pool transitions from "no relay connected" to "some relay connected"
 * (app start while online included, since `statusChanges` replays the
 * current value).
 */
import { Context, Data, Effect, Layer, Option, Schema, Stream } from "effect";

import { KeyValueStorage } from "../../ports/KeyValueStorage.js";
import type { NostrEvent } from "./NostrEvent.js";
import { NostrEventSchema } from "./NostrEvent.js";
import { RelayPool } from "./RelayPool.js";

export const PENDING_EVENTS_STORAGE_KEY = "linky.nostr.pendingEvents.v1";

/** Storage failed or holds data that no longer decodes as a pending queue. */
export class NostrPendingQueueError extends Data.TaggedError("NostrPendingQueueError")<{
  readonly operation: "load" | "save";
  readonly cause?: unknown;
}> {}

export interface PendingFlushOutcome {
  /** Ids accepted by ≥ 1 relay during this flush, in send order. */
  readonly sentEventIds: ReadonlyArray<string>;
  /** Ids from this flush's snapshot that are still queued. */
  readonly remainingEventIds: ReadonlyArray<string>;
}

export interface NostrPendingQueueService {
  /** Adds a signed event to the outbox. No-op if the id is already queued. */
  readonly enqueue: (event: NostrEvent) => Effect.Effect<void, NostrPendingQueueError>;
  /** The queued events, oldest first. */
  readonly pending: Effect.Effect<ReadonlyArray<NostrEvent>, NostrPendingQueueError>;
  /** Drops an event (e.g. the user deleted the unsent message). */
  readonly remove: (eventId: string) => Effect.Effect<void, NostrPendingQueueError>;
  /** Publishes queued events in order; see module docs for semantics. */
  readonly flush: Effect.Effect<PendingFlushOutcome, NostrPendingQueueError>;
}

export class NostrPendingQueue extends Context.Tag("@linky/core/NostrPendingQueue")<
  NostrPendingQueue,
  NostrPendingQueueService
>() {}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const StoredQueue = Schema.parseJson(Schema.Array(NostrEventSchema));
const decodeStoredQueue = Schema.decodeUnknownEither(StoredQueue);
const encodeStoredQueue = Schema.encodeSync(StoredQueue);

/**
 * Builds the service. Exposed for tests that simulate an app restart by
 * constructing two instances over the same `KeyValueStore`; production code
 * uses `layerNostrPendingQueue`.
 */
export const makeNostrPendingQueue: Effect.Effect<
  NostrPendingQueueService,
  never,
  KeyValueStorage.KeyValueStore | RelayPool
> = Effect.gen(function* () {
  const kv = yield* KeyValueStorage.KeyValueStore;
  const pool = yield* RelayPool;
  const storeLock = yield* Effect.makeSemaphore(1);
  const flushLock = yield* Effect.makeSemaphore(1);

  const load: Effect.Effect<ReadonlyArray<NostrEvent>, NostrPendingQueueError> = kv
    .get(PENDING_EVENTS_STORAGE_KEY)
    .pipe(
      Effect.mapError((cause) => new NostrPendingQueueError({ operation: "load", cause })),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed<ReadonlyArray<NostrEvent>>([]),
          onSome: (raw) =>
            Effect.suspend(() => {
              const decoded = decodeStoredQueue(raw);
              return decoded._tag === "Right"
                ? Effect.succeed(decoded.right)
                : Effect.fail(
                    new NostrPendingQueueError({ operation: "load", cause: decoded.left }),
                  );
            }),
        }),
      ),
    );

  const save = (events: ReadonlyArray<NostrEvent>) =>
    kv
      .set(PENDING_EVENTS_STORAGE_KEY, encodeStoredQueue(events))
      .pipe(Effect.mapError((cause) => new NostrPendingQueueError({ operation: "save", cause })));

  const enqueue = (event: NostrEvent) =>
    storeLock.withPermits(1)(
      Effect.gen(function* () {
        const events = yield* load;
        if (events.some((existing) => existing.id === event.id)) return;
        yield* save([...events, event]);
      }),
    );

  const remove = (eventId: string) =>
    storeLock.withPermits(1)(
      Effect.gen(function* () {
        const events = yield* load;
        const next = events.filter((event) => event.id !== eventId);
        if (next.length !== events.length) yield* save(next);
      }),
    );

  const flush = flushLock.withPermits(1)(
    Effect.gen(function* () {
      const snapshot = yield* load;
      const sentEventIds: Array<string> = [];
      for (const event of snapshot) {
        const outcome = yield* pool.publish(event).pipe(Effect.either);
        if (outcome._tag === "Right") {
          sentEventIds.push(event.id);
          yield* remove(event.id);
        }
        // Failed events stay queued; later events are still attempted.
      }
      return {
        sentEventIds,
        remainingEventIds: snapshot
          .map((event) => event.id)
          .filter((id) => !sentEventIds.includes(id)),
      };
    }),
  );

  return { enqueue, pending: load, remove, flush };
});

export const layerNostrPendingQueue: Layer.Layer<
  NostrPendingQueue,
  never,
  KeyValueStorage.KeyValueStore | RelayPool
> = Layer.effect(NostrPendingQueue, makeNostrPendingQueue);

// ---------------------------------------------------------------------------
// Flush trigger
// ---------------------------------------------------------------------------

/**
 * Long-running workflow: flushes the pending queue every time the pool goes
 * from "no relay connected" to "≥ 1 relay connected" — which includes app
 * start when a relay connects. Flush failures are swallowed so the loop
 * survives storage hiccups; the next reconnect retries. Fork this once at
 * app startup.
 */
export const runPendingFlushLoop: Effect.Effect<void, never, NostrPendingQueue | RelayPool> =
  Effect.gen(function* () {
    const pool = yield* RelayPool;
    const queue = yield* NostrPendingQueue;
    yield* pool.statusChanges.pipe(
      Stream.map((statuses) => [...statuses.values()].some((status) => status === "connected")),
      Stream.changes,
      Stream.filter((anyConnected) => anyConnected),
      Stream.runForEach(() => queue.flush.pipe(Effect.ignore)),
    );
  });
