/**
 * fakeRelay — an in-memory Nostr relay network implementing the
 * `NostrTransport` port for tests (core's own and downstream packages').
 *
 * Deterministic and clock-free: relays answer synchronously, so all timing
 * in tests comes from TestClock driving the pool's policies, never from
 * real I/O. Per relay you can script:
 *
 * - connectivity (`setOnline`) — going offline refuses new connections and
 *   drops live ones with a transport failure, like a real network cut;
 * - the publish response (`setPublishResponse`) — accept (NIP-20 OK true),
 *   reject (OK false), or stay silent (client hits its ack timeout); also
 *   as a per-event function for partial-failure scenarios;
 * - server-initiated events (`emitEvent`) — stored and broadcast to
 *   matching live subscriptions, as if another client had published.
 *
 * Observability for assertions: `publishedEvents` (every EVENT frame
 * received, duplicates included), `storedEvents` (accepted, deduped by id),
 * `connectionCount`.
 */
import { Effect, Exit, Layer, Mailbox } from "effect";
import type { Stream } from "effect";

import type { NostrRelaySocket } from "../../ports/NostrTransport.js";
import { NostrTransport, NostrTransportError } from "../../ports/NostrTransport.js";
import { matchesAnyFilter } from "./filter.js";
import type { NostrFilter } from "./filter.js";
import type { NostrEvent } from "./NostrEvent.js";
import type { ClientMessage } from "./relayMessages.js";
import { decodeClientMessage, encodeRelayMessage } from "./relayMessages.js";

export type FakePublishResponse =
  | { readonly _tag: "accept" }
  | { readonly _tag: "reject"; readonly message: string }
  | { readonly _tag: "silent" };

export type FakePublishResponder =
  | FakePublishResponse
  | ((event: NostrEvent) => FakePublishResponse);

export interface FakeRelayControls {
  readonly url: string;
  /** Going offline drops all live connections and refuses new ones. */
  readonly setOnline: (online: boolean) => Effect.Effect<void>;
  readonly setPublishResponse: (responder: FakePublishResponder) => Effect.Effect<void>;
  /** Every EVENT frame this relay ever received (duplicates included). */
  readonly publishedEvents: Effect.Effect<ReadonlyArray<NostrEvent>>;
  /** Accepted events, deduped by id (what the relay would serve to REQs). */
  readonly storedEvents: Effect.Effect<ReadonlyArray<NostrEvent>>;
  /** Stores an event and delivers it to matching live subscriptions. */
  readonly emitEvent: (event: NostrEvent) => Effect.Effect<void>;
  readonly connectionCount: Effect.Effect<number>;
}

export interface FakeRelayNetwork {
  /** The `NostrTransport` Layer backed by this network. */
  readonly transport: Layer.Layer<NostrTransport>;
  /** Controls for a relay URL (created on first use, online by default). */
  readonly relay: (url: string) => Effect.Effect<FakeRelayControls>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface ConnectionState {
  readonly mailbox: Mailbox.Mailbox<string, NostrTransportError>;
  readonly subscriptions: Map<string, ReadonlyArray<NostrFilter>>;
  open: boolean;
}

interface RelayRecord {
  readonly url: string;
  online: boolean;
  responder: FakePublishResponder;
  readonly published: Array<NostrEvent>;
  readonly stored: Map<string, NostrEvent>;
  readonly connections: Set<ConnectionState>;
  readonly controls: FakeRelayControls;
}

export const makeFakeRelayNetwork: Effect.Effect<FakeRelayNetwork> = Effect.sync(() => {
  const relays = new Map<string, RelayRecord>();

  const broadcast = (relay: RelayRecord, event: NostrEvent): void => {
    for (const connection of relay.connections) {
      for (const [subscriptionId, filters] of connection.subscriptions) {
        if (!matchesAnyFilter(event, filters)) continue;
        connection.mailbox.unsafeOffer(
          encodeRelayMessage({ _tag: "RelayEventMessage", subscriptionId, event }),
        );
      }
    }
  };

  const handleClientMessage = (
    relay: RelayRecord,
    connection: ConnectionState,
    message: ClientMessage,
  ): void => {
    switch (message._tag) {
      case "ClientEventMessage": {
        const event = message.event;
        relay.published.push(event);
        const response =
          typeof relay.responder === "function" ? relay.responder(event) : relay.responder;
        switch (response._tag) {
          case "accept":
            relay.stored.set(event.id, event);
            connection.mailbox.unsafeOffer(
              encodeRelayMessage({
                _tag: "RelayOkMessage",
                eventId: event.id,
                accepted: true,
                message: "",
              }),
            );
            broadcast(relay, event);
            return;
          case "reject":
            connection.mailbox.unsafeOffer(
              encodeRelayMessage({
                _tag: "RelayOkMessage",
                eventId: event.id,
                accepted: false,
                message: response.message,
              }),
            );
            return;
          case "silent":
            return;
        }
        return;
      }
      case "ClientReqMessage": {
        connection.subscriptions.set(message.subscriptionId, message.filters);
        for (const event of relay.stored.values()) {
          if (!matchesAnyFilter(event, message.filters)) continue;
          connection.mailbox.unsafeOffer(
            encodeRelayMessage({
              _tag: "RelayEventMessage",
              subscriptionId: message.subscriptionId,
              event,
            }),
          );
        }
        connection.mailbox.unsafeOffer(
          encodeRelayMessage({ _tag: "RelayEoseMessage", subscriptionId: message.subscriptionId }),
        );
        return;
      }
      case "ClientCloseMessage":
        connection.subscriptions.delete(message.subscriptionId);
        return;
    }
  };

  const getOrCreate = (url: string): RelayRecord => {
    const existing = relays.get(url);
    if (existing !== undefined) return existing;

    const record: RelayRecord = {
      url,
      online: true,
      responder: { _tag: "accept" },
      published: [],
      stored: new Map(),
      connections: new Set(),
      controls: {
        url,
        setOnline: (online) =>
          Effect.gen(function* () {
            record.online = online;
            if (online) return;
            const dropped = [...record.connections];
            record.connections.clear();
            yield* Effect.forEach(
              dropped,
              (connection) => {
                connection.open = false;
                return connection.mailbox.done(
                  Exit.fail(
                    new NostrTransportError({
                      relayUrl: url,
                      reason: "closed",
                      cause: "fake relay went offline",
                    }),
                  ),
                );
              },
              { discard: true },
            );
          }),
        setPublishResponse: (responder) =>
          Effect.sync(() => {
            record.responder = responder;
          }),
        publishedEvents: Effect.sync(() => [...record.published]),
        storedEvents: Effect.sync(() => [...record.stored.values()]),
        emitEvent: (event) =>
          Effect.sync(() => {
            record.stored.set(event.id, event);
            broadcast(record, event);
          }),
        connectionCount: Effect.sync(() => record.connections.size),
      },
    };
    relays.set(url, record);
    return record;
  };

  const connect = (relayUrl: string) =>
    Effect.gen(function* () {
      const relay = getOrCreate(relayUrl);
      if (!relay.online) {
        return yield* Effect.fail(
          new NostrTransportError({
            relayUrl,
            reason: "connect",
            cause: "fake relay offline",
          }),
        );
      }
      const mailbox = yield* Mailbox.make<string, NostrTransportError>();
      const connection: ConnectionState = { mailbox, subscriptions: new Map(), open: true };
      relay.connections.add(connection);

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          connection.open = false;
          relay.connections.delete(connection);
          yield* mailbox.shutdown;
        }),
      );

      const send = (frame: string): Effect.Effect<void, NostrTransportError> =>
        Effect.suspend(() => {
          if (!connection.open || !relay.online) {
            return Effect.fail(
              new NostrTransportError({
                relayUrl,
                reason: "send",
                cause: "connection closed",
              }),
            );
          }
          const decoded = decodeClientMessage(frame);
          if (decoded._tag === "Some") handleClientMessage(relay, connection, decoded.value);
          return Effect.void;
        });

      const frames: Stream.Stream<string, NostrTransportError> = Mailbox.toStream(mailbox);
      const socket: NostrRelaySocket = { send, frames };
      return socket;
    });

  return {
    transport: Layer.succeed(NostrTransport, { connect }),
    relay: (url) => Effect.sync(() => getOrCreate(url).controls),
  };
});
