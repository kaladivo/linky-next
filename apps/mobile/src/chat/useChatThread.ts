/**
 * useChatThread — resolves a chat route param to its thread and loads the
 * conversation window (#28, extended for the full chat screen in #29).
 *
 * The contacts list routes BOTH saved contacts and unknown threads to
 * `chat/[id]`; the id is a contact id or an unknown-thread id, so
 * resolution tries contacts first, then unknown threads.
 *
 * Conversation data, per loaded window (cursor pages of PAGE_SIZE):
 * - `messages` NEWEST first (matches the inverted FlatList; full history
 *   reachable via `loadOlder` — `chat.retention`: no hard caps);
 * - `reactions`: all active reaction events of the loaded messages (one
 *   query; chips + toggle plans are derived in conversationModel);
 * - `replyPreviews`: looked-up originals for reply targets OUTSIDE the
 *   window (null = unavailable/deleted → localized fallback);
 * - `ownNpub`: the ACTIVE identity's npub (chips highlighting, edit
 *   permission).
 *
 * Re-queries on store data version changes (repository writes bump it via
 * `invalidateStoreData`), so sends, inbox arrivals, edits and deletes
 * update a mounted screen. Same plain-async staleness guard as
 * useContactsScreenData.
 */
import { loadSession } from "@linky/core";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import type {
  ContactRecord,
  LinkyStore,
  MessageRecord,
  ReactionRecord,
  UnknownThreadRecord,
} from "@linky/evolu-store";
import {
  createContactsRepository,
  createMessagesRepository,
  createUnknownThreadsRepository,
  loadActiveReactions,
} from "@linky/evolu-store";

import { runAppEffect } from "../runtime";
import { getStoreDataVersion, subscribeToStoreData } from "../store/storeManager";
import { missingReplyTargets } from "./conversationModel";

/** Page size; `loadOlder` extends the window by one more page. */
const PAGE_SIZE = 50;

export type ChatThread =
  | { readonly kind: "contact"; readonly contact: ContactRecord }
  | { readonly kind: "unknown"; readonly thread: UnknownThreadRecord };

/** The conversation peer's npub, or null (contact without an npub). */
export const chatThreadNpub = (thread: ChatThread): string | null =>
  thread.kind === "contact" ? thread.contact.npub : thread.thread.npub;

export interface ChatConversation {
  readonly thread: ChatThread;
  /** Newest first (inverted-list order). */
  readonly messages: ReadonlyArray<MessageRecord>;
  /** Active reaction events for the loaded messages. */
  readonly reactions: ReadonlyArray<ReactionRecord>;
  /** Off-window reply targets: rumor id → original (null = unavailable). */
  readonly replyPreviews: ReadonlyMap<string, MessageRecord | null>;
  /** Active identity npub; null only when no session loads (defensive). */
  readonly ownNpub: string | null;
  /** True when older history exists beyond the loaded window. */
  readonly hasMore: boolean;
}

export type ChatThreadState =
  | { readonly status: "loading" }
  | { readonly status: "not-found" }
  | ({ readonly status: "ready" } & ChatConversation);

export interface UseChatThreadResult {
  readonly state: ChatThreadState;
  /** Extends the window one page into the past (no-op without more). */
  readonly loadOlder: () => void;
}

const loadOwnNpub = async (): Promise<string | null> => {
  try {
    const session = await runAppEffect(loadSession);
    return session._tag === "IdentityLoaded"
      ? session.session.activeNostr.identity.npub
      : null;
  } catch {
    return null;
  }
};

export const useChatThread = (store: LinkyStore | null, id: string | null): UseChatThreadResult => {
  const [state, setState] = useState<ChatThreadState>({ status: "loading" });
  const [pageCount, setPageCount] = useState(1);
  const dataVersion = useSyncExternalStore(subscribeToStoreData, getStoreDataVersion);

  useEffect(() => {
    if (store === null || id === null || id.length === 0) {
      setState({ status: "loading" });
      return;
    }
    let stale = false;

    const load = async (): Promise<ChatThreadState> => {
      const contacts = createContactsRepository(store);
      const threads = createUnknownThreadsRepository(store);
      const messages = createMessagesRepository(store);

      const contact = await contacts.getById(id);
      const thread: ChatThread | null =
        contact !== null
          ? { kind: "contact", contact }
          : await threads.getById(id).then((row) =>
              row === null ? null : ({ kind: "unknown", thread: row } as const),
            );
      if (thread === null) return { status: "not-found" };

      const npub = chatThreadNpub(thread);
      if (npub === null) {
        return {
          status: "ready",
          thread,
          messages: [],
          reactions: [],
          replyPreviews: new Map(),
          ownNpub: await loadOwnNpub(),
          hasMore: false,
        };
      }

      // Newest-first cursor pages up to the requested window size.
      const items: MessageRecord[] = [];
      let cursor: { sentAtSec: number; id: string } | undefined;
      let hasMore = false;
      for (let page = 0; page < pageCount; page++) {
        const result = await messages.listPage({
          peerNpub: npub,
          limit: PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        });
        items.push(...result.items);
        if (result.nextCursor === null) {
          hasMore = false;
          break;
        }
        cursor = result.nextCursor;
        hasMore = true;
      }

      const reactions = await loadActiveReactions(
        store,
        items.map((message) => message.rumorId),
      );

      const replyPreviews = new Map<string, MessageRecord | null>();
      for (const target of missingReplyTargets(items)) {
        replyPreviews.set(target, await messages.getByRumorId(target));
      }

      return {
        status: "ready",
        thread,
        messages: items,
        reactions,
        replyPreviews,
        ownNpub: await loadOwnNpub(),
        hasMore,
      };
    };

    void load().then((next) => {
      if (!stale) setState(next);
    });
    return () => {
      stale = true;
    };
  }, [store, id, dataVersion, pageCount]);

  const hasMore = state.status === "ready" && state.hasMore;
  const loadOlder = useCallback(() => {
    if (hasMore) setPageCount((count) => count + 1);
  }, [hasMore]);

  return { state, loadOlder };
};
