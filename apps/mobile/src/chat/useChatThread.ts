/**
 * useChatThread — resolves a chat route param to its thread and loads the
 * conversation (#28).
 *
 * The contacts list routes BOTH saved contacts and unknown threads to
 * `chat/[id]`; the id is a contact id or an unknown-thread id, so
 * resolution tries contacts first, then unknown threads. Messages come
 * from `MessagesRepository.listPage` (newest-first page, reversed here for
 * display). Re-queries on store data version changes (repository writes
 * bump it via `invalidateStoreData`), so a block/promote elsewhere updates
 * a mounted screen. Same plain-async staleness guard as
 * useContactsScreenData.
 */
import { useEffect, useState, useSyncExternalStore } from "react";

import type { ContactRecord, LinkyStore, MessageRecord, UnknownThreadRecord } from "@linky/evolu-store";
import {
  createContactsRepository,
  createMessagesRepository,
  createUnknownThreadsRepository,
} from "@linky/evolu-store";

import { getStoreDataVersion, subscribeToStoreData } from "../store/storeManager";

/** First page size — pagination joins with the real chat screen (#29). */
const PAGE_SIZE = 50;

export type ChatThread =
  | { readonly kind: "contact"; readonly contact: ContactRecord }
  | { readonly kind: "unknown"; readonly thread: UnknownThreadRecord };

/** The conversation peer's npub, or null (contact without an npub). */
export const chatThreadNpub = (thread: ChatThread): string | null =>
  thread.kind === "contact" ? thread.contact.npub : thread.thread.npub;

export type ChatThreadState =
  | { readonly status: "loading" }
  | { readonly status: "not-found" }
  | {
      readonly status: "ready";
      readonly thread: ChatThread;
      /** Oldest first (display order). */
      readonly messages: ReadonlyArray<MessageRecord>;
    };

export const useChatThread = (store: LinkyStore | null, id: string | null): ChatThreadState => {
  const [state, setState] = useState<ChatThreadState>({ status: "loading" });
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
      const page =
        npub === null ? { items: [] } : await messages.listPage({ peerNpub: npub, limit: PAGE_SIZE });
      return { status: "ready", thread, messages: [...page.items].reverse() };
    };

    void load().then((next) => {
      if (!stale) setState(next);
    });
    return () => {
      stale = true;
    };
  }, [store, id, dataVersion]);

  return state;
};
