/**
 * useContactsScreenData — repository reads behind the Contacts tab (#26).
 *
 * Loads the filtered contact list (with previews), the unknown-thread inbox
 * and the group names in parallel, re-querying when the filter, the search
 * text or the store data version changes (repository writes bump the
 * version via `invalidateStoreData` — see storeManager.ts).
 *
 * Plain async on purpose: repositories are the plain-TypeScript surface of
 * @linky/evolu-store (not Effect workflows), so this hook guards staleness
 * itself — only the latest request may settle state, like useEffectQuery.
 */
import { useEffect, useState, useSyncExternalStore } from "react";

import type { LinkyStore } from "@linky/evolu-store";
import {
  createContactsRepository,
  createUnknownThreadsRepository,
} from "@linky/evolu-store";
import type { ContactListItem, UnknownThreadListItem } from "@linky/evolu-store";

import { getStoreDataVersion, subscribeToStoreData } from "../store/storeManager";
import { toContactFilter } from "./contactsListModel";
import type { GroupFilterSelection } from "./contactsListModel";
import { groupFilterKey } from "./contactsListModel";

export interface ContactsScreenData {
  readonly items: ReadonlyArray<ContactListItem>;
  readonly unknownThreads: ReadonlyArray<UnknownThreadListItem>;
  readonly groups: ReadonlyArray<string>;
}

export type ContactsScreenDataState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: ContactsScreenData };

export const useContactsScreenData = (
  store: LinkyStore | null,
  selection: GroupFilterSelection,
  search: string,
): ContactsScreenDataState => {
  const [state, setState] = useState<ContactsScreenDataState>({ status: "loading" });
  const dataVersion = useSyncExternalStore(subscribeToStoreData, getStoreDataVersion);
  const selectionKey = groupFilterKey(selection);
  const trimmedSearch = search.trim();

  useEffect(() => {
    if (store === null) {
      setState({ status: "loading" });
      return;
    }
    let stale = false;
    const contactsRepo = createContactsRepository(store);
    const threadsRepo = createUnknownThreadsRepository(store);
    void Promise.all([
      contactsRepo.listWithPreviews(toContactFilter(selection, trimmedSearch)),
      threadsRepo.list(),
      contactsRepo.listGroups(),
    ]).then(([items, unknownThreads, groups]) => {
      if (stale) return;
      setState({ status: "ready", data: { items, unknownThreads, groups } });
    });
    return () => {
      stale = true;
    };
    // selectionKey stands in for the selection object (rebuilt per render).
  }, [store, selectionKey, trimmedSearch, dataVersion]);

  return state;
};
