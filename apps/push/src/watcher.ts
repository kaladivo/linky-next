/**
 * Relay watcher (notifications.service-watch) — one live kind-1059
 * subscription per configured relay over core's `NostrTransport` port,
 * with per-relay EOSE gating, cross-relay dedupe and Expo delivery.
 *
 * Why not core's `RelayPool`: the pool hides EOSE (it is a client sync
 * abstraction), and EOSE is exactly the signal this service needs —
 * "historical" is defined as ANY event a relay serves as stored backfill
 * (before that connection's EOSE). Only events arriving on an established
 * live subscription may notify. This is deliberately conservative: events
 * published while the service was down are never late-notified
 * (notifications.md: catch-up must not deliver historical notifications).
 *
 * The REQ still asks for `since = now - catchUpLookbackSec` (default 3
 * days): NIP-59 wraps carry `created_at` jittered up to 2 days into the
 * past, so a narrower window would make relays withhold *live* wraps.
 * `created_at` is therefore useless for freshness — gating is purely
 * arrival-based (pre-EOSE = historical), never timestamp-based.
 *
 * Divergence from the PoC: the PoC marked historical events as seen before
 * suppressing them, so a slow relay's backfill could mask a fast relay's
 * live delivery of a genuinely new event. Here historical events are NOT
 * recorded — only delivered events enter the dedupe store — which closes
 * that race; suppression of re-served backfill is inherent (it always
 * re-arrives pre-EOSE). The PoC's 10-minute full resubscribe is dropped:
 * a healthy connection keeps streaming, and any reconnect re-enters via
 * backfill + EOSE anyway.
 *
 * Delivery dedupe (notifications.dedupe) is two-layered and persistent:
 * event ids (`seen_events`, pruned after retention) catch cross-relay and
 * cross-restart duplicates; (event id, token) pairs (`deliveries`) catch
 * tokens reachable through more than one registration row — the
 * old-install/new-install overlap.
 */
import { Clock, Effect, Option, Stream } from "effect";
import type { NostrEvent } from "@linky/core";
import {
  decodeRelayMessage,
  encodeClientMessage,
  GIFT_WRAP_KIND,
  NostrTransport,
} from "@linky/core";

import { PushConfig } from "./config.js";
import { classifyWrap } from "./filter.js";
import type { RelayWatchStatus } from "./http.js";
import type { PushMessage } from "./pushSender.js";
import { PushSender } from "./pushSender.js";
import { PushStorage } from "./storage.js";

const SUBSCRIPTION_ID = "linky-push-watch";
const RECONNECT_DELAY_MS = 3_000;

/** Generic copy by design — the service cannot decrypt, the app enriches. */
const NOTIFICATION_TITLE = "Linky";
const NOTIFICATION_BODY = "You have a new message";

export interface Watcher {
  /** Runs forever (all relay loops); interrupt to stop. */
  readonly run: Effect.Effect<void>;
  /** Live per-relay state for /health. */
  readonly status: Effect.Effect<Readonly<Record<string, RelayWatchStatus>>>;
}

export const makeWatcher: Effect.Effect<
  Watcher,
  never,
  PushConfig | PushStorage | PushSender | NostrTransport
> = Effect.gen(function* () {
  const config = yield* PushConfig;
  const storage = yield* PushStorage;
  const sender = yield* PushSender;
  const transport = yield* NostrTransport;

  const relayState = new Map<string, { live: boolean; lastLiveEventAtMs: number | null }>();
  for (const url of config.relayUrls) {
    relayState.set(url, { live: false, lastLiveEventAtMs: null });
  }
  const state = (url: string) => {
    const existing = relayState.get(url);
    if (existing !== undefined) return existing;
    const fresh = { live: false, lastLiveEventAtMs: null };
    relayState.set(url, fresh);
    return fresh;
  };

  const handleLiveEvent = (event: NostrEvent): Effect.Effect<void> =>
    Effect.gen(function* () {
      const classification = classifyWrap(event);
      if (classification._tag === "ignore") return;

      const registrations = yield* storage.registrationsForPubkey(classification.recipientPubkey);
      if (registrations.length === 0) return;

      const nowMs = yield* Clock.currentTimeMillis;
      // Atomic first-writer-wins across relays and restarts.
      const fresh = yield* storage.markEventSeen(event.id, nowMs);
      if (!fresh) return;

      const tokens = [...new Set(registrations.map((row) => row.expoPushToken))];
      const targets: Array<string> = [];
      for (const token of tokens) {
        if (yield* storage.markDelivered(event.id, token, nowMs)) targets.push(token);
      }
      if (targets.length === 0) return;

      const messages: Array<PushMessage> = targets.map((token) => ({
        to: token,
        title: NOTIFICATION_TITLE,
        body: NOTIFICATION_BODY,
        data: {
          type: "nostr_inbox",
          eventId: event.id,
          recipientPubkey: classification.recipientPubkey,
          createdAt: event.created_at,
        },
      }));
      const results = yield* sender.send(messages);
      for (const result of results) {
        if (result.outcome === "device-not-registered") {
          yield* storage.removeToken(result.token);
          yield* Effect.logInfo(`push: dropped dead token registrations event=${event.id}`);
        }
      }
      yield* Effect.logInfo(
        `push: delivered event=${event.id} recipient=${classification.recipientPubkey} targets=${targets.length}`,
      );
    });

  const watchConnection = (url: string): Effect.Effect<void, unknown> =>
    Effect.scoped(
      Effect.gen(function* () {
        const socket = yield* transport.connect(url);
        const relay = state(url);
        relay.live = false;
        const nowMs = yield* Clock.currentTimeMillis;
        const since = Math.floor(nowMs / 1000) - config.catchUpLookbackSec;
        yield* socket.send(
          encodeClientMessage({
            _tag: "ClientReqMessage",
            subscriptionId: SUBSCRIPTION_ID,
            filters: [{ kinds: [GIFT_WRAP_KIND], since }],
          }),
        );
        yield* Effect.logInfo(`push: watching relay=${url} since=${since}`);
        yield* Stream.runForEach(socket.frames, (frame) =>
          Effect.gen(function* () {
            const decoded = decodeRelayMessage(frame);
            if (Option.isNone(decoded)) return;
            const message = decoded.value;
            if (message._tag === "RelayEoseMessage" && message.subscriptionId === SUBSCRIPTION_ID) {
              relay.live = true;
              yield* Effect.logInfo(`push: relay live (EOSE) relay=${url}`);
              return;
            }
            if (
              message._tag === "RelayEventMessage" &&
              message.subscriptionId === SUBSCRIPTION_ID
            ) {
              // Pre-EOSE = historical backfill: never notifies, never
              // recorded (see module doc for why not even marked seen).
              if (!relay.live) return;
              relay.lastLiveEventAtMs = yield* Clock.currentTimeMillis;
              yield* handleLiveEvent(message.event);
            }
          }),
        );
      }),
    );

  const watchRelay = (url: string): Effect.Effect<void> =>
    watchConnection(url).pipe(
      Effect.catchAllCause((cause) =>
        Effect.logWarning(`push: relay connection ended relay=${url}`, cause),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          state(url).live = false;
        }),
      ),
      Effect.zipRight(Effect.sleep(RECONNECT_DELAY_MS)),
      Effect.forever,
    );

  return {
    run: Effect.forEach(config.relayUrls, watchRelay, {
      concurrency: "unbounded",
      discard: true,
    }),
    status: Effect.sync(() => {
      const snapshot: Record<string, RelayWatchStatus> = {};
      for (const [url, relay] of relayState) {
        snapshot[url] = { live: relay.live, lastLiveEventAtMs: relay.lastLiveEventAtMs };
      }
      return snapshot;
    }),
  };
});
