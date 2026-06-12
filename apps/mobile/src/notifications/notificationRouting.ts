/**
 * Notification tap routing (#52) — "tapping routes into the right chat".
 *
 * Two arrival shapes:
 * - LOCAL rich notifications (`linky_chat`) carry the resolved chat id —
 *   route directly.
 * - REMOTE service pushes (`nostr_inbox`) carry only the wrap event id +
 *   recipient pubkey (the service cannot know more). The app resolves the
 *   peer ON-DEVICE: fetch the kind-1059 wrap by id from the relay pool,
 *   NIP-17-unwrap it with the active identity's secret (the same
 *   decryption the rich-copy contract describes), then map the sender to
 *   the contact/unknown-thread id the chat screen expects. Every step is
 *   best-effort with a deadline; any failure falls back to the home tab
 *   (conversations list) — never a dead tap.
 */
import { loadSession, publicKeyHexToNpub, RelayPool, unwrapGiftWrap } from "@linky/core";
import type { NostrEvent } from "@linky/core";
import {
  createContactsRepository,
  createUnknownThreadsRepository,
} from "@linky/evolu-store";
import type { LinkyStore } from "@linky/evolu-store";
import { Effect, Option, Stream } from "effect";
import { router } from "expo-router";

import { runAppEffect } from "../runtime";
import { getStoreState, subscribeToStore } from "../store/storeManager";
import type { NotificationData } from "./expoNotificationsModule";
import { LOCAL_CHAT_TYPE, REMOTE_INBOX_TYPE } from "./expoNotificationsModule";

/** How long a cold-started app may take to boot its store. */
const STORE_READY_TIMEOUT_MS = 12_000;
/** Relay window for the wrap-by-id fetch. */
const WRAP_FETCH_WINDOW = "6 seconds";
/** Window for the inbox sync to materialize a brand-new thread. */
const THREAD_LOOKUP_RETRIES = 10;
const THREAD_LOOKUP_DELAY_MS = 500;

const waitForStore = (): Promise<LinkyStore | null> =>
  new Promise((resolve) => {
    const current = getStoreState();
    if (current.status === "ready") {
      resolve(current.store);
      return;
    }
    let done = false;
    const finish = (store: LinkyStore | null) => {
      if (done) return;
      done = true;
      unsubscribe();
      clearTimeout(timer);
      resolve(store);
    };
    const unsubscribe = subscribeToStore(() => {
      const state = getStoreState();
      if (state.status === "ready") finish(state.store);
    });
    const timer = setTimeout(() => finish(null), STORE_READY_TIMEOUT_MS);
  });

/** One-shot relay fetch of a kind-1059 wrap by id (deduped across relays). */
const fetchWrapById = async (eventId: string): Promise<NostrEvent | null> => {
  try {
    const wrap = await runAppEffect(
      Effect.gen(function* () {
        const pool = yield* RelayPool;
        return yield* pool.subscribe([{ ids: [eventId], kinds: [1059], limit: 1 }]).pipe(
          Stream.take(1),
          Stream.interruptAfter(WRAP_FETCH_WINDOW),
          Stream.runHead,
        );
      }),
    );
    return Option.getOrNull(wrap);
  } catch {
    return null;
  }
};

/** The wrap's authenticated sender pubkey via on-device NIP-17 decryption. */
const peerPubkeyOfWrap = async (wrap: NostrEvent): Promise<string | null> => {
  try {
    const session = await runAppEffect(loadSession);
    if (session._tag !== "IdentityLoaded") return null;
    const secretKey = session.session.activeNostr.identity.secretKey;
    const unwrapped = unwrapGiftWrap(wrap, secretKey, {
      nowSec: Math.floor(Date.now() / 1000),
    });
    return unwrapped._tag === "Right" ? unwrapped.right.senderPubkey : null;
  } catch {
    return null;
  }
};

/** contact id / unknown-thread id for a peer npub; retries while the inbox
 * sync (woken by the same tap) materializes a first-contact thread. */
const chatIdForPeer = async (store: LinkyStore, npub: string): Promise<string | null> => {
  const contacts = createContactsRepository(store);
  const threads = createUnknownThreadsRepository(store);
  for (let attempt = 0; attempt < THREAD_LOOKUP_RETRIES; attempt += 1) {
    const contact = await contacts.findByNpub(npub);
    if (contact !== null) return contact.id;
    const thread = await threads.getByNpub(npub);
    if (thread !== null) return thread.id;
    await new Promise((resolve) => setTimeout(resolve, THREAD_LOOKUP_DELAY_MS));
  }
  return null;
};

const openChat = (chatId: string): void => {
  router.push(`/chat/${chatId}`);
};

const openHome = (): void => {
  router.push("/(tabs)");
};

/**
 * Routes a tapped notification. Returns the route taken (for logging /
 * debug); always navigates somewhere.
 */
export const routeForNotificationData = async (
  data: NotificationData,
): Promise<"chat" | "home"> => {
  if (data.type === LOCAL_CHAT_TYPE && data.chatId !== null) {
    openChat(data.chatId);
    return "chat";
  }

  if (data.type === REMOTE_INBOX_TYPE && data.eventId !== null) {
    const store = await waitForStore();
    if (store !== null) {
      const wrap = await fetchWrapById(data.eventId);
      const peerPubkey = wrap === null ? null : await peerPubkeyOfWrap(wrap);
      const npub = peerPubkey === null ? null : publicKeyHexToNpub(peerPubkey);
      const chatId = npub === null ? null : await chatIdForPeer(store, npub);
      if (chatId !== null) {
        openChat(chatId);
        return "chat";
      }
    }
  }

  openHome();
  return "home";
};
