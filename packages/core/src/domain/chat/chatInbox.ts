/**
 * Chat inbox sync — `nostr.inbox-sync` / `chat.receive-message`: subscribe
 * to our kind-1059 gift wraps via the RelayPool, unwrap, validate, dedupe,
 * and emit typed {@link ChatInboxSignal}s. Issue #22.
 *
 * The returned `Stream` IS the storage handoff port: #25 runs
 * `runChatInbox(...)` on the app runtime and persists what it emits —
 * `ChatEventReceived` upserts by `event.rumorId`, `ChatRumorDuplicate`
 * records the additional wrap id for an already-stored rumor (same message
 * arriving via different sync paths is stored once), `ChatWrapRejected` is
 * diagnostics only. Seeding `knownWrapIds` / `knownRumorIds` from storage
 * makes restarts skip already-processed wraps without re-emitting.
 *
 * Custom-key switch contract (#20): when the active identity is a custom
 * key, rumors timestamped BEFORE `activatedAtSec` belong to the previous
 * identity's history and are dropped
 * ({@link passesIdentitySwitchFilter}, the PoC's `identitySinceSec` rule).
 *
 * Dedup layers, in order:
 * 1. wrap id — transport duplicates (same wrap from several relays /
 *    restarts); silently skipped, nothing new can be learned from them;
 * 2. rumor id — the same message in a different envelope (recipient wrap +
 *    self wrap, re-wraps); surfaced as `ChatRumorDuplicate` so storage can
 *    remember the extra wrap id.
 */
import { Clock, Effect, Either, Option, Stream } from "effect";

import type { ActiveNostrIdentity } from "../identity/customNostrKey.js";
import type { NostrEvent } from "../nostr/NostrEvent.js";
import type { NostrFilter } from "../nostr/filter.js";
import { RelayPool } from "../nostr/RelayPool.js";
import type { ChatEvent, ChatRumorRejectionReason } from "./chatEvents.js";
import { classifyRumor } from "./chatEvents.js";
import type { GiftWrapRejectionReason } from "./giftWrap.js";
import { GIFT_WRAP_KIND, unwrapGiftWrap } from "./giftWrap.js";

// ---------------------------------------------------------------------------
// Identity-switch filtering (#20 contract)
// ---------------------------------------------------------------------------

/**
 * `true` when an event timestamped `createdAtSec` belongs to the ACTIVE
 * identity: always for the derived key; for a custom key only from the
 * switch moment on (`created_at >= activatedAtSec`, PoC parity).
 */
export const passesIdentitySwitchFilter = (
  identity: ActiveNostrIdentity,
  createdAtSec: number,
): boolean => identity.source !== "custom" || createdAtSec >= identity.activatedAtSec;

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/** Everything that can make the inbox ignore a wrap, for diagnostics. */
export type ChatInboxRejectionReason =
  | GiftWrapRejectionReason
  | ChatRumorRejectionReason
  | "before-identity-switch";

export type ChatInboxSignal =
  | {
      /** A new, validated chat event — store it under `event.rumorId`. */
      readonly _tag: "ChatEventReceived";
      readonly event: ChatEvent;
      readonly wrapId: string;
    }
  | {
      /** A known rumor arrived via another wrap — record the wrap id only. */
      readonly _tag: "ChatRumorDuplicate";
      readonly rumorId: string;
      readonly wrapId: string;
    }
  | {
      /** Ignored wrap (malformed, spoofed, pre-switch, unsupported …). */
      readonly _tag: "ChatWrapRejected";
      readonly wrapId: string;
      readonly rumorId: string | null;
      readonly reason: ChatInboxRejectionReason;
    };

export interface ChatInboxOptions {
  /** Wrap ids already processed (from storage) — skipped silently. */
  readonly knownWrapIds?: Iterable<string>;
  /** Rumor ids already stored — re-arrivals emit `ChatRumorDuplicate`. */
  readonly knownRumorIds?: Iterable<string>;
  /** Override for the future-timestamp tolerance (unit tests). */
  readonly futureToleranceSec?: number;
}

/** The NIP-01 filter the inbox subscribes with (exported for #25/#29 reuse). */
export const chatInboxFilters = (publicKeyHex: string): ReadonlyArray<NostrFilter> => [
  { kinds: [GIFT_WRAP_KIND], "#p": [publicKeyHex] },
];

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

/**
 * The inbox sync workflow. Runs until the consuming fiber is interrupted;
 * never fails — bad input becomes `ChatWrapRejected` signals. Reconnects,
 * relay fan-in and signature verification are the RelayPool's business.
 */
export const runChatInbox = (
  identity: ActiveNostrIdentity,
  options: ChatInboxOptions = {},
): Stream.Stream<ChatInboxSignal, never, RelayPool> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const pool = yield* RelayPool;
      const seenWrapIds = new Set<string>(options.knownWrapIds ?? []);
      const seenRumorIds = new Set<string>(options.knownRumorIds ?? []);
      const secretKey = identity.identity.secretKey;
      const publicKeyHex = identity.identity.publicKeyHex;

      const processWrap = (wrap: NostrEvent, nowSec: number): Option.Option<ChatInboxSignal> => {
        if (seenWrapIds.has(wrap.id)) return Option.none();
        seenWrapIds.add(wrap.id);

        const unwrapped = unwrapGiftWrap(wrap, secretKey, {
          nowSec,
          // RelayPool.subscribe already id+signature-verified the wrap.
          skipWrapSignatureCheck: true,
          ...(options.futureToleranceSec !== undefined
            ? { futureToleranceSec: options.futureToleranceSec }
            : {}),
        });
        if (Either.isLeft(unwrapped)) {
          return Option.some({
            _tag: "ChatWrapRejected",
            wrapId: wrap.id,
            rumorId: null,
            reason: unwrapped.left.reason,
          });
        }
        const validated = unwrapped.right;

        if (!passesIdentitySwitchFilter(identity, validated.rumor.created_at)) {
          return Option.some({
            _tag: "ChatWrapRejected",
            wrapId: wrap.id,
            rumorId: validated.rumor.id,
            reason: "before-identity-switch",
          });
        }

        if (seenRumorIds.has(validated.rumor.id)) {
          return Option.some({
            _tag: "ChatRumorDuplicate",
            rumorId: validated.rumor.id,
            wrapId: wrap.id,
          });
        }

        const classified = classifyRumor(validated, {
          recipientSecretKey: secretKey,
          recipientPublicKeyHex: publicKeyHex,
        });
        if (Either.isLeft(classified)) {
          return Option.some({
            _tag: "ChatWrapRejected",
            wrapId: wrap.id,
            rumorId: classified.left.rumorId,
            reason: classified.left.reason,
          });
        }

        seenRumorIds.add(validated.rumor.id);
        return Option.some({
          _tag: "ChatEventReceived",
          event: classified.right,
          wrapId: wrap.id,
        });
      };

      return pool.subscribe(chatInboxFilters(publicKeyHex)).pipe(
        Stream.mapEffect((wrap) =>
          Effect.map(Clock.currentTimeMillis, (millis) =>
            processWrap(wrap, Math.floor(millis / 1000)),
          ),
        ),
        Stream.filterMap((signal) => signal),
      );
    }),
  );
