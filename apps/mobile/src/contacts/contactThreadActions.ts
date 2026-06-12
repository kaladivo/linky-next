/**
 * Unknown-sender + contact lifecycle actions (#28): promote an unknown
 * thread to a saved contact, delete a contact back to an unknown thread,
 * and block a sender (local block + Nostr kind-10000 mute-list publish).
 *
 * Storage is #25's repositories (conversations are keyed by npub, so
 * promote/delete never move message rows); the mute list is core's
 * `publishMuteList`, which fetches the current relay-side list and MERGES
 * the local blocklist into it (feature-map contract: a block never replaces
 * unrelated entries). The local block always applies even when the publish
 * fails or queues — PoC behavior (`blockPubkeyAndPublishMuteList`).
 *
 * Plain async like the repositories; only the Nostr work runs as an Effect
 * on the app runtime. Screens render the returned plain results — they
 * never see Effect errors. Used by chat/[id] (unknown banner) and
 * contact/[id] (delete / block-archived); #27's full edit screen can reuse
 * these as-is.
 */
import {
  fetchProfileMetadata,
  loadSession,
  npubToPublicKeyHex,
  publishMuteList,
} from "@linky/core";
import {
  createBlocksRepository,
  createContactsRepository,
  createMessagesRepository,
  createUnknownThreadsRepository,
} from "@linky/evolu-store";
import type { LinkyStore } from "@linky/evolu-store";
import { Effect, Option } from "effect";

import { runAppEffect } from "../runtime";
import { invalidateStoreData } from "../store/storeManager";

const nowSec = (): number => Math.floor(Date.now() / 1000);

// ─── contacts.promote-unknown ────────────────────────────────────────────

export type PromoteUnknownResult =
  /** Contact created (or it already existed); thread row removed. */
  | { readonly outcome: "promoted" | "already-contact"; readonly contactId: string }
  | { readonly outcome: "failed" };

/**
 * Pre-warms the kind-0 metadata cache for an unknown sender. Fired when the
 * unknown chat screen opens, so the promote tap finds the name in the cache
 * (the PoC equivalent: `unknownNameByNpub` filled by a background fetch).
 * Fire-and-forget; never throws.
 */
export const warmUnknownSenderMetadata = (npub: string): void => {
  const pubkeyHex = npubToPublicKeyHex(npub);
  if (pubkeyHex === null) return;
  void runAppEffect(fetchProfileMetadata(pubkeyHex)).catch(() => undefined);
};

/**
 * Saves the unknown sender behind `threadId` as a real contact
 * (`contacts.promote-unknown`). The name is prefilled from the sender's
 * cached kind-0 metadata when available (#24; short relay window otherwise
 * — a missing name is fine, the list renders the deterministic default
 * name for the npub). Messages need no migration: the conversation is
 * matched to the new contact by npub, and the local-only thread row is
 * simply removed.
 */
export const promoteUnknownThread = async (
  store: LinkyStore,
  threadId: string,
): Promise<PromoteUnknownResult> => {
  const threads = createUnknownThreadsRepository(store);
  const contacts = createContactsRepository(store);

  const thread = await threads.getById(threadId);
  if (thread === null) return { outcome: "failed" };

  // Duplicate-npub safety: if a contact for this npub already exists the
  // thread is stale — drop it and reuse the contact (PoC behavior).
  const existing = await contacts.findByNpub(thread.npub);
  if (existing !== null) {
    await threads.remove(thread.npub);
    invalidateStoreData();
    return { outcome: "already-contact", contactId: existing.id };
  }

  const metadataName = await fetchCachedSenderName(thread.npub);
  const inserted = contacts.insert({
    npub: thread.npub,
    ...(metadataName === null ? {} : { name: metadataName }),
  });
  if (!inserted.ok) return { outcome: "failed" };

  await threads.remove(thread.npub);
  invalidateStoreData();
  return { outcome: "promoted", contactId: inserted.value.id };
};

/** Cached metadata name (display_name > name), or null. Never throws. */
const fetchCachedSenderName = async (npub: string): Promise<string | null> => {
  const pubkeyHex = npubToPublicKeyHex(npub);
  if (pubkeyHex === null) return null;
  try {
    // Cache-first; the short window keeps a cold-cache promote snappy
    // (warmUnknownSenderMetadata usually filled the cache already).
    const metadata = await runAppEffect(
      fetchProfileMetadata(pubkeyHex, { queryWindow: "2 seconds" }),
    );
    return Option.match(metadata, {
      onNone: () => null,
      onSome: (value) => value.displayName ?? value.name ?? null,
    });
  } catch {
    return null;
  }
};

// ─── contacts.delete-to-unknown ──────────────────────────────────────────

export type DeleteContactResult = "deleted" | "deleted-to-unknown" | "failed";

/**
 * Deletes a saved contact (`contacts.delete-to-unknown`). The contact row
 * is soft-deleted — the tombstone syncs, so no other device resurrects the
 * contact — while an existing conversation is preserved under a local-only
 * unknown thread for the same npub (messages stay in place, npub-keyed).
 * Contacts without a conversation just disappear.
 */
export const deleteContactToUnknown = async (
  store: LinkyStore,
  contactId: string,
): Promise<DeleteContactResult> => {
  const contacts = createContactsRepository(store);
  const messages = createMessagesRepository(store);
  const threads = createUnknownThreadsRepository(store);

  const contact = await contacts.getById(contactId);
  if (contact === null) return "failed";

  let hasConversation = false;
  if (contact.npub !== null) {
    const page = await messages.listPage({ peerNpub: contact.npub, limit: 1 });
    hasConversation = page.items.length > 0;
  }

  // Thread first, then tombstone: if the app dies in between, the worst
  // case is an extra unknown thread next to a still-saved contact (the
  // list prefers the contact; promote cleans the leftover thread up).
  if (hasConversation && contact.npub !== null) {
    const created = await threads.create(contact.npub, nowSec());
    if (!created.ok) return "failed";
  }
  const removed = contacts.remove(contactId);
  if (!removed.ok) return "failed";

  invalidateStoreData();
  return hasConversation ? "deleted-to-unknown" : "deleted";
};

// ─── contacts.block ──────────────────────────────────────────────────────

/** How the mute-list publish went; the LOCAL block applied regardless. */
export type MutePublishOutcome = "accepted" | "queued" | "skipped" | "failed";

export interface BlockSenderResult {
  readonly blocked: boolean;
  /**
   * Settles when the mute-list publish does; never rejects. The UI must
   * NOT wait for this (the merge fetch takes its relay window, and the
   * offline path runs the pool's full retry policy before queueing — PoC
   * behavior is fire-and-forget too). It exists so callers/tests CAN
   * observe the outcome; it is also logged.
   */
  readonly mutePublish: Promise<MutePublishOutcome>;
}

/**
 * Blocks `npub` (`contacts.block` / `nostr.block-pubkey`): stores the
 * synced block row (enforcement lives in `applyChatEvent`, which drops
 * every inbound event from a blocked sender — the thread can never be
 * recreated), removes the local unknown thread, then publishes the merged
 * kind-10000 mute list with the FULL local blocklist (heals earlier missed
 * publishes). Publish failures never undo the local block.
 *
 * `mutePublish` outcomes: "accepted" (≥1 relay ACKed) | "queued" (offline —
 * flushed by the pending queue later) | "skipped" (no session or no
 * decodable blocked npub) | "failed" (unexpected error; local block still
 * active).
 */
export const blockSender = async (
  store: LinkyStore,
  npub: string,
): Promise<BlockSenderResult> => {
  const blocks = createBlocksRepository(store);
  const threads = createUnknownThreadsRepository(store);

  const blocked = await blocks.block(npub, nowSec());
  if (!blocked.ok) return { blocked: false, mutePublish: Promise.resolve("skipped") };
  await threads.remove(npub);
  invalidateStoreData();

  // Full local blocklist → hex p-tag entries (undecodable npubs — e.g. dev
  // seeds — stay blocked locally but cannot appear in a Nostr mute list).
  const blockedNpubs = (await blocks.list()).map((record) => record.npub);
  const blockedPubkeys = blockedNpubs
    .map((value) => npubToPublicKeyHex(value))
    .filter((value): value is string => value !== null);
  if (blockedPubkeys.length === 0) {
    return { blocked: true, mutePublish: Promise.resolve("skipped") };
  }

  const mutePublish: Promise<MutePublishOutcome> = runAppEffect(
    Effect.gen(function* () {
      const session = yield* loadSession;
      if (session._tag !== "IdentityLoaded") return "skipped" as const;
      const result = yield* publishMuteList(session.session.activeNostr, blockedPubkeys);
      return result.delivery.outcome;
    }),
  )
    .catch((): MutePublishOutcome => "failed")
    .then((outcome) => {
      // Observable in the Metro console for dev verification (#28).
      if (__DEV__) console.log(`[contacts.block] mute-list publish: ${outcome}`);
      return outcome;
    });

  return { blocked: true, mutePublish };
};

/**
 * Blocks an ARCHIVED contact (`contacts.block` from the archived edit
 * screen): same block pipeline, plus the contact row itself is
 * soft-deleted (PoC `blockArchivedContact`). Chat history is not touched —
 * blocking stops future inbound, it never deletes the past.
 */
export const blockArchivedContact = async (
  store: LinkyStore,
  contactId: string,
): Promise<BlockSenderResult & { readonly removedContact: boolean }> => {
  const contacts = createContactsRepository(store);
  const contact = await contacts.getById(contactId);
  if (contact === null || contact.npub === null) {
    return { blocked: false, mutePublish: Promise.resolve("skipped"), removedContact: false };
  }
  const result = await blockSender(store, contact.npub);
  if (!result.blocked) return { ...result, removedContact: false };
  const removed = contacts.remove(contactId);
  invalidateStoreData();
  return { ...result, removedContact: removed.ok };
};
