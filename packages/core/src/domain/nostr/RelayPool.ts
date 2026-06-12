/**
 * RelayPool — one service managing the configured relay set
 * (`CurrentEnvironment.nostrRelayUrls`): connections with automatic
 * reconnect, publish with per-relay retry, pooled subscriptions with dedup,
 * and a live per-relay status map (`nostr.probe-relays`,
 * `nostr.publish-retry` in the feature map).
 *
 * Behavior contract:
 *
 * - **Status** — every relay is always `"checking" | "connected" |
 *   "disconnected"`; the map is queryable (`status`) and observable
 *   (`statusChanges`, a SubscriptionRef-backed stream that replays the
 *   current value). Designed for the deferred-startup probe and the relay
 *   settings screen (#31).
 * - **Publish** — the event is offered to *every* relay. The returned
 *   effect succeeds as soon as one relay ACKs (NIP-20 `OK true`) and keeps
 *   retrying the remaining relays in background fibers (owned by the pool's
 *   scope) with capped exponential backoff up to `publishMaxAttempts` per
 *   relay. Transient failures (not connected, send error, OK timeout) are
 *   retried; an explicit `OK false` rejection is terminal for that relay.
 *   If no relay accepts, fails with `NostrPublishError` listing per-relay
 *   failures.
 * - **Subscribe** — one logical subscription is fanned out as a REQ to every
 *   relay (re-issued on reconnect); events are deduplicated by id and
 *   signature-verified before they reach the consumer. The REQ is CLOSEd on
 *   all relays when the stream's consumer stops.
 *
 * All timing (backoff, ack timeout) goes through Effect's Clock — tests
 * drive it with TestClock.
 */
import type { Scope } from "effect";
import {
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Layer,
  Mailbox,
  Schedule,
  Stream,
  SubscriptionRef,
} from "effect";

import { CurrentEnvironment } from "../environment/CurrentEnvironment.js";
import type { NostrRelaySocket, NostrTransportError } from "../../ports/NostrTransport.js";
import { NostrTransport } from "../../ports/NostrTransport.js";
import type { NostrFilter } from "./filter.js";
import type { NostrEvent } from "./NostrEvent.js";
import { verifyNostrEvent } from "./NostrEvent.js";
import { decodeRelayMessage, encodeClientMessage } from "./relayMessages.js";

// ---------------------------------------------------------------------------
// Public model
// ---------------------------------------------------------------------------

export type RelayStatus = "checking" | "connected" | "disconnected";

export interface PublishOutcome {
  readonly eventId: string;
  /** Relays that had accepted when the publish resolved (≥ 1). Remaining relays keep retrying in background. */
  readonly acceptedBy: ReadonlyArray<string>;
}

export interface RelayPublishFailure {
  readonly relayUrl: string;
  readonly message: string;
}

/** No relay accepted the event within the retry policy. */
export class NostrPublishError extends Data.TaggedError("NostrPublishError")<{
  readonly eventId: string;
  readonly failures: ReadonlyArray<RelayPublishFailure>;
}> {}

export interface RelayPoolConfig {
  /** How long to wait for a relay's `OK` after sending an EVENT. */
  readonly ackTimeout: Duration.DurationInput;
  /** Per-relay publish attempts (first try included). */
  readonly publishMaxAttempts: number;
  /** First publish retry delay; doubles each retry. */
  readonly publishRetryBaseDelay: Duration.DurationInput;
  /** Cap for publish retry delays. */
  readonly publishRetryMaxDelay: Duration.DurationInput;
  /** First reconnect delay after a failed connect; doubles each failure. */
  readonly reconnectBaseDelay: Duration.DurationInput;
  /** Cap for reconnect delays. */
  readonly reconnectMaxDelay: Duration.DurationInput;
}

export const defaultRelayPoolConfig: RelayPoolConfig = {
  ackTimeout: "5 seconds",
  publishMaxAttempts: 6,
  publishRetryBaseDelay: "1 second",
  publishRetryMaxDelay: "30 seconds",
  reconnectBaseDelay: "1 second",
  reconnectMaxDelay: "30 seconds",
};

export interface RelayPoolService {
  /** The configured relay set (deduplicated, in configuration order). */
  readonly relayUrls: ReadonlyArray<string>;
  /**
   * Publishes a signed event to all relays. Succeeds on first acceptance;
   * passing an unsigned/tampered event is a defect.
   */
  readonly publish: (event: NostrEvent) => Effect.Effect<PublishOutcome, NostrPublishError>;
  /** Live events matching the filters, across all relays, deduped by id. */
  readonly subscribe: (filters: ReadonlyArray<NostrFilter>) => Stream.Stream<NostrEvent>;
  /** Current per-relay connection status. */
  readonly status: Effect.Effect<ReadonlyMap<string, RelayStatus>>;
  /** Status map stream: replays the current value, then every change. */
  readonly statusChanges: Stream.Stream<ReadonlyMap<string, RelayStatus>>;
}

export class RelayPool extends Context.Tag("@linky/core/RelayPool")<
  RelayPool,
  RelayPoolService
>() {}

// ---------------------------------------------------------------------------
// Internal errors (per-relay publish attempts; surfaced as failure messages)
// ---------------------------------------------------------------------------

class RelayNotConnectedError extends Data.TaggedError("RelayNotConnectedError")<{
  readonly relayUrl: string;
}> {}

class RelayAckTimeoutError extends Data.TaggedError("RelayAckTimeoutError")<{
  readonly relayUrl: string;
  readonly eventId: string;
}> {}

class RelayRejectedError extends Data.TaggedError("RelayRejectedError")<{
  readonly relayUrl: string;
  readonly eventId: string;
  readonly message: string;
}> {}

type PublishAttemptError =
  | RelayNotConnectedError
  | RelayAckTimeoutError
  | RelayRejectedError
  | NostrTransportError;

const failureMessage = (error: PublishAttemptError): string => {
  switch (error._tag) {
    case "RelayNotConnectedError":
      return "relay not connected";
    case "RelayAckTimeoutError":
      return "timed out waiting for OK";
    case "RelayRejectedError":
      return `rejected: ${error.message}`;
    case "NostrTransportError":
      return `transport ${error.reason}`;
  }
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface RelayAck {
  readonly accepted: boolean;
  readonly message: string;
}

interface SubscriptionState {
  readonly filters: ReadonlyArray<NostrFilter>;
  readonly seenEventIds: Set<string>;
  readonly mailbox: Mailbox.Mailbox<NostrEvent>;
}

interface RelayState {
  readonly url: string;
  /** Non-null only while the relay session is connected. */
  connection: NostrRelaySocket | null;
  /** Publish attempts awaiting an OK, keyed by event id. */
  readonly pendingAcks: Map<string, Set<Deferred.Deferred<RelayAck>>>;
}

const capDelay = (base: Duration.DurationInput, max: Duration.DurationInput, exponent: number) =>
  Duration.min(
    Duration.decode(max),
    Duration.times(Duration.decode(base), 2 ** Math.min(exponent, 16)),
  );

const makeRelayPool = (
  config: RelayPoolConfig,
): Effect.Effect<RelayPoolService, never, Scope.Scope | NostrTransport | CurrentEnvironment> =>
  Effect.gen(function* () {
    const transport = yield* NostrTransport;
    const environment = yield* CurrentEnvironment;
    const poolScope = yield* Effect.scope;

    const relayUrls = [...new Set<string>(environment.nostrRelayUrls)];
    const relays: ReadonlyArray<RelayState> = relayUrls.map((url) => ({
      url,
      connection: null,
      pendingAcks: new Map(),
    }));

    // All mutable collections below are only touched from effects running on
    // this runtime (single-threaded), never across `yield*` boundaries
    // within one logical update — no extra locking needed.
    const subscriptions = new Map<string, SubscriptionState>();
    let subscriptionCounter = 0;

    const statusRef = yield* SubscriptionRef.make<ReadonlyMap<string, RelayStatus>>(
      new Map(relayUrls.map((url) => [url, "checking" as RelayStatus])),
    );
    const setStatus = (url: string, status: RelayStatus) =>
      SubscriptionRef.update(statusRef, (current) =>
        current.get(url) === status ? current : new Map(current).set(url, status),
      );

    // -- frame handling ------------------------------------------------------

    const handleFrame = (relay: RelayState, frame: string) =>
      Effect.sync(() => {
        const decoded = decodeRelayMessage(frame);
        if (decoded._tag === "None") return;
        const message = decoded.value;
        switch (message._tag) {
          case "RelayOkMessage": {
            const waiters = relay.pendingAcks.get(message.eventId);
            if (waiters === undefined) return;
            for (const waiter of waiters) {
              Deferred.unsafeDone(
                waiter,
                Effect.succeed({ accepted: message.accepted, message: message.message }),
              );
            }
            return;
          }
          case "RelayEventMessage": {
            const subscription = subscriptions.get(message.subscriptionId);
            if (subscription === undefined) return;
            if (subscription.seenEventIds.has(message.event.id)) return;
            if (!verifyNostrEvent(message.event)) return;
            subscription.seenEventIds.add(message.event.id);
            subscription.mailbox.unsafeOffer(message.event);
            return;
          }
          // EOSE / CLOSED / NOTICE / AUTH carry no client state to update here.
          default:
            return;
        }
      });

    const sendActiveSubscriptions = (socket: NostrRelaySocket) =>
      Effect.forEach(
        subscriptions.entries(),
        ([subscriptionId, subscription]) =>
          socket
            .send(
              encodeClientMessage({
                _tag: "ClientReqMessage",
                subscriptionId,
                filters: subscription.filters,
              }),
            )
            .pipe(Effect.ignore),
        { discard: true },
      );

    // -- per-relay connection loop -------------------------------------------

    /** One connect-and-pump session; resolves with whether it ever connected. */
    const runSession = (relay: RelayState): Effect.Effect<boolean> =>
      Effect.suspend(() => {
        let connected = false;
        return Effect.scoped(
          Effect.gen(function* () {
            yield* setStatus(relay.url, "checking");
            const socket = yield* transport.connect(relay.url);
            connected = true;
            relay.connection = socket;
            yield* setStatus(relay.url, "connected");
            yield* sendActiveSubscriptions(socket);
            yield* Stream.runForEach(socket.frames, (frame) => handleFrame(relay, frame));
          }),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              relay.connection = null;
            }),
          ),
          Effect.ignore,
          Effect.map(() => connected),
        );
      });

    const relayLoop = (relay: RelayState) =>
      Effect.gen(function* () {
        let consecutiveFailures = 0;
        while (true) {
          const connected = yield* runSession(relay);
          yield* setStatus(relay.url, "disconnected");
          consecutiveFailures = connected ? 0 : consecutiveFailures + 1;
          yield* Effect.sleep(
            capDelay(
              config.reconnectBaseDelay,
              config.reconnectMaxDelay,
              Math.max(0, consecutiveFailures - 1),
            ),
          );
        }
      });

    yield* Effect.forEach(relays, (relay) => Effect.forkScoped(relayLoop(relay)), {
      discard: true,
    });

    // -- publish ---------------------------------------------------------------

    const publishAttempt = (
      relay: RelayState,
      event: NostrEvent,
    ): Effect.Effect<void, PublishAttemptError> =>
      Effect.gen(function* () {
        const connection = relay.connection;
        if (connection === null) {
          return yield* Effect.fail(new RelayNotConnectedError({ relayUrl: relay.url }));
        }
        const ack = yield* Deferred.make<RelayAck>();
        const waiters = relay.pendingAcks.get(event.id) ?? new Set();
        waiters.add(ack);
        relay.pendingAcks.set(event.id, waiters);
        const unregister = Effect.sync(() => {
          waiters.delete(ack);
          if (waiters.size === 0) relay.pendingAcks.delete(event.id);
        });
        return yield* connection
          .send(encodeClientMessage({ _tag: "ClientEventMessage", event }))
          .pipe(
            Effect.zipRight(
              Deferred.await(ack).pipe(
                Effect.timeoutFail({
                  duration: config.ackTimeout,
                  onTimeout: () =>
                    new RelayAckTimeoutError({ relayUrl: relay.url, eventId: event.id }),
                }),
              ),
            ),
            Effect.filterOrFail(
              (reply): reply is RelayAck => reply.accepted,
              (reply) =>
                new RelayRejectedError({
                  relayUrl: relay.url,
                  eventId: event.id,
                  message: reply.message,
                }),
            ),
            Effect.asVoid,
            Effect.ensuring(unregister),
          );
      });

    const publishRetrySchedule = Schedule.exponential(config.publishRetryBaseDelay, 2).pipe(
      Schedule.union(Schedule.spaced(config.publishRetryMaxDelay)),
    );

    const publishToRelay = (relay: RelayState, event: NostrEvent) =>
      publishAttempt(relay, event).pipe(
        Effect.retry({
          schedule: publishRetrySchedule,
          times: Math.max(0, config.publishMaxAttempts - 1),
          while: (error) => error._tag !== "RelayRejectedError",
        }),
      );

    const publish = (event: NostrEvent): Effect.Effect<PublishOutcome, NostrPublishError> =>
      Effect.gen(function* () {
        if (!verifyNostrEvent(event)) {
          return yield* Effect.die(
            new Error("RelayPool.publish requires a validly signed NostrEvent"),
          );
        }
        const result = yield* Deferred.make<PublishOutcome, NostrPublishError>();
        const acceptedBy: Array<string> = [];
        const failures: Array<RelayPublishFailure> = [];
        let remaining = relays.length;

        yield* Effect.forEach(
          relays,
          (relay) =>
            publishToRelay(relay, event).pipe(
              Effect.matchEffect({
                onSuccess: () =>
                  Effect.suspend(() => {
                    acceptedBy.push(relay.url);
                    return Deferred.succeed(result, {
                      eventId: event.id,
                      acceptedBy: [...acceptedBy],
                    });
                  }),
                onFailure: (error) =>
                  Effect.sync(() => {
                    failures.push({ relayUrl: relay.url, message: failureMessage(error) });
                  }),
              }),
              Effect.ensuring(
                Effect.suspend(() => {
                  remaining -= 1;
                  return remaining === 0 && acceptedBy.length === 0
                    ? Deferred.fail(
                        result,
                        new NostrPublishError({ eventId: event.id, failures: [...failures] }),
                      )
                    : Effect.void;
                }),
              ),
              Effect.forkIn(poolScope),
            ),
          { discard: true },
        );

        return yield* Deferred.await(result);
      });

    // -- subscribe ---------------------------------------------------------------

    const subscribe = (filters: ReadonlyArray<NostrFilter>): Stream.Stream<NostrEvent> =>
      Stream.unwrapScoped(
        Effect.gen(function* () {
          subscriptionCounter += 1;
          const subscriptionId = `linky-sub-${subscriptionCounter}`;
          const mailbox = yield* Mailbox.make<NostrEvent>();
          subscriptions.set(subscriptionId, { filters, seenEventIds: new Set(), mailbox });

          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              subscriptions.delete(subscriptionId);
              // The CLOSE frames are advisory (the map delete above already
              // drops any further events), so they must never block scope
              // close. Finalizers run with interruption masked AND — for the
              // standard unsubscribe path, a consumer interrupted by e.g.
              // `Stream.interruptAfter` — with an interrupt already pending,
              // where a socket send on the consumer's own fiber either hangs
              // (#28: every profile/mute-list fetch on device) or gets cut
              // short. Forking into the pool scope detaches the sends from
              // the dying fiber; they settle thanks to the transport's
              // interruptible send race.
              yield* Effect.forkIn(
                Effect.forEach(
                  relays,
                  (relay) =>
                    relay.connection === null
                      ? Effect.void
                      : relay.connection
                          .send(encodeClientMessage({ _tag: "ClientCloseMessage", subscriptionId }))
                          .pipe(Effect.ignore),
                  { discard: true },
                ).pipe(Effect.interruptible),
                poolScope,
              );
              yield* mailbox.shutdown;
            }),
          );

          yield* Effect.forEach(
            relays,
            (relay) =>
              relay.connection === null
                ? Effect.void
                : relay.connection
                    .send(
                      encodeClientMessage({ _tag: "ClientReqMessage", subscriptionId, filters }),
                    )
                    .pipe(Effect.ignore),
            { discard: true },
          );

          return Mailbox.toStream(mailbox);
        }),
      );

    return {
      relayUrls,
      publish,
      subscribe,
      status: SubscriptionRef.get(statusRef),
      statusChanges: statusRef.changes,
    };
  });

/**
 * Production Layer. Needs `NostrTransport` (see `layerNostrTransportSocket`)
 * and `CurrentEnvironment` (relay set). Connection loops live as long as the
 * Layer's scope.
 */
export const layerRelayPool = (
  config: Partial<RelayPoolConfig> = {},
): Layer.Layer<RelayPool, never, NostrTransport | CurrentEnvironment> =>
  Layer.scoped(RelayPool, makeRelayPool({ ...defaultRelayPoolConfig, ...config }));
