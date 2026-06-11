/**
 * NostrTransport port — raw WebSocket-framed access to a single Nostr relay.
 *
 * Core cannot touch the `WebSocket` global, so relay connectivity enters
 * through this tag. The port speaks *text frames* (NIP-01 JSON strings);
 * the protocol itself (REQ/EVENT/OK/EOSE) is domain code in
 * `src/domain/nostr/`.
 *
 * Like `HttpClient`, the production wiring rides on `@effect/platform`:
 * `layerNostrTransportSocket` below implements the port on top of
 * `Socket.makeWebSocket` and only needs `Socket.WebSocketConstructor` —
 * which the app provides with `Socket.layerWebSocketConstructorGlobal`
 * (React Native and browsers both expose a global `WebSocket`; see
 * `WebSocketConstructorLive` in `packages/platform`). The Layer itself is
 * platform-neutral, which is why it may live here despite the "core ships
 * no production Layers" default.
 *
 * Tests use the in-memory fake relay network
 * (`src/domain/nostr/fakeRelay.ts`) instead of this Layer.
 */
import { Socket } from "@effect/platform";
import { Context, Data, Deferred, Effect, Exit, Layer, Mailbox } from "effect";
import type { Duration, Scope, Stream } from "effect";

export class NostrTransportError extends Data.TaggedError("NostrTransportError")<{
  readonly relayUrl: string;
  /** `connect` = never opened; `send` = write failed; `closed` = connection ended. */
  readonly reason: "connect" | "send" | "closed";
  readonly cause?: unknown;
}> {}

/** An open relay connection. Owned by the `Scope` that `connect` ran in. */
export interface NostrRelaySocket {
  /** Sends one text frame. Fails fast once the connection has closed. */
  readonly send: (frame: string) => Effect.Effect<void, NostrTransportError>;
  /**
   * Incoming text frames. Ends when the relay closes the connection
   * cleanly; fails with `NostrTransportError` when it drops.
   */
  readonly frames: Stream.Stream<string, NostrTransportError>;
}

export interface NostrTransportService {
  /**
   * Opens a connection and resolves once the socket is OPEN (or fails with
   * reason `"connect"`, including on open timeout). The connection lives in
   * the surrounding `Scope`.
   */
  readonly connect: (
    relayUrl: string,
  ) => Effect.Effect<NostrRelaySocket, NostrTransportError, Scope.Scope>;
}

export class NostrTransport extends Context.Tag("@linky/core/NostrTransport")<
  NostrTransport,
  NostrTransportService
>() {}

// ---------------------------------------------------------------------------
// WebSocket-backed implementation (via @effect/platform Socket)
// ---------------------------------------------------------------------------

const toTransportError = (relayUrl: string, error: Socket.SocketError): NostrTransportError =>
  new NostrTransportError({
    relayUrl,
    reason: error.reason === "Open" || error.reason === "OpenTimeout" ? "connect" : "closed",
    cause: error,
  });

/**
 * Implements `NostrTransport` on `@effect/platform`'s Socket module.
 * Requires `Socket.WebSocketConstructor` (provide
 * `Socket.layerWebSocketConstructorGlobal` in the app).
 */
export const layerNostrTransportSocket = (options?: {
  readonly openTimeout?: Duration.DurationInput;
}): Layer.Layer<NostrTransport, never, Socket.WebSocketConstructor> =>
  Layer.effect(
    NostrTransport,
    Effect.gen(function* () {
      const webSocketConstructor = yield* Socket.WebSocketConstructor;
      const openTimeout = options?.openTimeout ?? "10 seconds";

      const connect: NostrTransportService["connect"] = (relayUrl) =>
        Effect.gen(function* () {
          const socket = yield* Socket.makeWebSocket(relayUrl, { openTimeout }).pipe(
            Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor),
          );
          const incoming = yield* Mailbox.make<string, NostrTransportError>();
          const opened = yield* Deferred.make<void, NostrTransportError>();

          // Pump the socket until it ends. Lifecycle mapping:
          //   clean close  -> frames stream ends
          //   drop / error -> frames stream fails with NostrTransportError
          //   scope closed -> stream ends (we initiated the shutdown)
          yield* socket
            .runRaw(
              (data) => {
                if (typeof data === "string") incoming.unsafeOffer(data);
              },
              { onOpen: Deferred.succeed(opened, undefined) },
            )
            .pipe(
              Effect.mapError((error) => toTransportError(relayUrl, error)),
              Effect.onExit((exit) =>
                Effect.zipRight(
                  // If the socket ended before opening, fail `connect`.
                  Deferred.done(
                    opened,
                    Exit.isSuccess(exit)
                      ? Exit.fail(
                          new NostrTransportError({
                            relayUrl,
                            reason: "connect",
                            cause: "socket closed before opening",
                          }),
                        )
                      : exit,
                  ),
                  incoming.done(Exit.isInterrupted(exit) ? Exit.void : exit),
                ),
              ),
              Effect.forkScoped,
            );

          yield* Deferred.await(opened);
          const write = yield* socket.writer;

          // `writer` blocks forever once the socket is gone; racing against
          // mailbox completion turns that into a prompt typed failure.
          const closedSignal = incoming.await.pipe(
            Effect.matchEffect({
              onSuccess: () => Effect.fail(new NostrTransportError({ relayUrl, reason: "closed" })),
              onFailure: (error) => Effect.fail(error),
            }),
          );
          const send = (frame: string) =>
            write(frame).pipe(
              Effect.mapError(
                (error) => new NostrTransportError({ relayUrl, reason: "send", cause: error }),
              ),
              Effect.raceFirst(closedSignal),
            );

          return { send, frames: Mailbox.toStream(incoming) };
        });

      return { connect };
    }),
  );
