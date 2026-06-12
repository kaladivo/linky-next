/**
 * chatInboxRunner — wires the #22 inbox sync loop (`runChatInbox`) into the
 * app (`chat.receive-message`, `chat.pending-ack`). Issue #29.
 *
 * Lifecycle: `initChatInboxRunner()` (idempotent, called once from the
 * deferred-startup tasks) subscribes to the session-scoped store AND the
 * session version:
 *
 * - store ready → start one inbox loop for (store, active identity);
 * - store torn down (logout/switch) → stop the loop;
 * - session version bump (custom Nostr key switch, #20) → restart so the
 *   loop subscribes/decrypts with the NEW identity and applies its
 *   `activatedAtSec` cutoff.
 *
 * Each received signal goes through `chatEventMapping` into
 * `MessagesRepository.applyChatEvent` — the single enforcement point for
 * blocked-drop, unknown-thread creation, rumor-id dedup and pending-ack.
 * `knownRumorIds` are seeded from storage so a restart skips re-applying
 * the whole history; `ChatRumorDuplicate` still triggers `markSent`
 * (no-op unless pending) so a pending optimistic send is acknowledged
 * even when its echo rumor id was already seeded.
 */
import { loadSession, runChatInbox } from "@linky/core";
import type { ActiveNostrIdentity, ChatInboxSignal } from "@linky/core";
import {
  createMessagesRepository,
  loadKnownRumorIds,
} from "@linky/evolu-store";
import type { LinkyStore, MessagesRepository } from "@linky/evolu-store";
import { Effect, Stream } from "effect";

import { runAppEffect } from "../runtime";
import {
  notifyInboundChatMessage,
  notifyIncomingChatPayment,
} from "../notifications/inAppRichNotifier";
import { acceptIncomingTokenMessage } from "./chatPayActions";
import { toChatEventInput } from "./chatEventMapping";
import { tokenMessageInfo } from "./chatPaymentsModel";
import { getSessionVersion, subscribeToSessionVersion } from "../session/sessionStore";
import {
  getStoreState,
  invalidateStoreData,
  subscribeToStore,
} from "../store/storeManager";

interface RunningInbox {
  readonly store: LinkyStore;
  readonly sessionVersion: number;
  readonly abort: AbortController;
}

let running: RunningInbox | null = null;
let initialized = false;

const applySignal = async (
  messages: MessagesRepository,
  identity: ActiveNostrIdentity,
  signal: ChatInboxSignal,
): Promise<void> => {
  switch (signal._tag) {
    case "ChatEventReceived": {
      const input = await toChatEventInput(
        signal.event,
        signal.wrapId,
        {
          publicKeyHex: identity.identity.publicKeyHex,
          npub: identity.identity.npub,
        },
        async (targetRumorId) => (await messages.getByRumorId(targetRumorId))?.peerNpub ?? null,
      );
      if (input === null) return;
      const applied = await messages.applyChatEvent(input);
      if (!applied.ok) {
        if (__DEV__) console.warn("[chat-inbox] apply failed:", applied.error.reason);
        return;
      }
      if (applied.value.outcome !== "blocked") invalidateStoreData();

      // chat-pay.receive-cashu (#44): a newly APPLIED inbound message whose
      // content carries a Cashu token is auto-accepted into the wallet.
      // Only "applied" — rumor-id dedup upstream makes replays/echoes
      // no-ops, so a token is never double-accepted from the same message.
      // Fire-and-forget: the mint swap must not block the inbox loop.
      if (
        applied.value.outcome === "applied" &&
        input.kind === "message" &&
        input.direction === "in"
      ) {
        const store = getStoreState();
        if (store.status === "ready") {
          const tokenInfo = tokenMessageInfo(input.content);
          if (tokenInfo === null) {
            // notifications.notify-message (#52): rich in-app alert for a
            // decrypted inbound text message — fire-and-forget, suppressed
            // for the open thread / a non-active app (inAppRichNotifier).
            void notifyInboundChatMessage(store.store, {
              peerNpub: input.peerNpub,
              content: input.content,
            }).catch(() => undefined);
          }
          void acceptIncomingTokenMessage(store.store, {
            peerNpub: input.peerNpub,
            content: input.content,
          })
            .then((outcome) => {
              if (__DEV__ && outcome !== "not-a-token") {
                console.log(`[chat-pay] auto-accept: ${outcome} (${input.content.length} chars)`);
              }
              // notifications.notify-payment (#52): the QUIET token message
              // stays unannounced; the wallet's successful accept is what
              // carries the rich payment copy (sender + amount). The marked
              // payment notice only rings the closed-app path.
              if (outcome === "accepted") {
                void notifyIncomingChatPayment(store.store, {
                  peerNpub: input.peerNpub,
                  amountSat: tokenInfo?.amountSat ?? null,
                }).catch(() => undefined);
              }
            })
            .catch((error: unknown) => {
              if (__DEV__) console.warn("[chat-inbox] token auto-accept died:", error);
            });
        }
      }
      return;
    }
    case "ChatRumorDuplicate": {
      // A seeded/known rumor arrived in another wrap. Only meaningful for
      // pending-ack: markSent without a wrap id is a no-op unless pending.
      const acked = await messages.markSent(signal.rumorId);
      if (acked.ok && acked.value.acknowledged) invalidateStoreData();
      return;
    }
    case "ChatWrapRejected":
      if (__DEV__) console.log(`[chat-inbox] rejected wrap ${signal.wrapId}: ${signal.reason}`);
      return;
  }
};

const startInbox = async (store: LinkyStore, sessionVersion: number): Promise<void> => {
  const abort = new AbortController();
  running = { store, sessionVersion, abort };

  let identity: ActiveNostrIdentity;
  try {
    const session = await runAppEffect(loadSession);
    if (session._tag !== "IdentityLoaded") {
      running = null;
      return;
    }
    identity = session.session.activeNostr;
  } catch (error) {
    if (__DEV__) console.warn("[chat-inbox] session load failed:", error);
    running = null;
    return;
  }
  if (abort.signal.aborted) return;

  const messages = createMessagesRepository(store);
  const knownRumorIds = await loadKnownRumorIds(store);
  if (abort.signal.aborted) return;

  if (__DEV__) {
    console.log(
      `[chat-inbox] starting for ${identity.identity.npub.slice(0, 12)}… ` +
        `(${knownRumorIds.length} known rumors)`,
    );
  }

  // The loop never fails (bad input → rejected signals); a defect or the
  // abort interrupt ends the promise. Signals are applied sequentially —
  // ordering matters for dedup bookkeeping.
  void runAppEffect(
    Stream.runForEach(runChatInbox(identity, { knownRumorIds }), (signal) =>
      Effect.promise(() => applySignal(messages, identity, signal)),
    ),
    { signal: abort.signal },
  ).catch((defect: unknown) => {
    if (abort.signal.aborted) return; // normal stop
    console.warn("[chat-inbox] loop died:", defect);
  });
};

const stopInbox = (): void => {
  running?.abort.abort();
  running = null;
};

/** Reconciles the running loop with the current store/session state. */
const reconcile = (): void => {
  const storeState = getStoreState();
  const sessionVersion = getSessionVersion();

  if (storeState.status !== "ready") {
    if (running !== null) stopInbox();
    return;
  }
  if (running !== null && running.store === storeState.store && running.sessionVersion === sessionVersion) {
    return; // already running for this store + identity
  }
  stopInbox();
  void startInbox(storeState.store, sessionVersion);
};

/**
 * Starts watching store/session state and runs the inbox loop whenever an
 * identity's store is ready. Idempotent; called from deferred startup.
 */
export const initChatInboxRunner = (): void => {
  if (initialized) return;
  initialized = true;
  subscribeToStore(reconcile);
  subscribeToSessionVersion(reconcile);
  reconcile();
};
