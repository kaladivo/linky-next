/**
 * useContactEditorData — repository reads behind the add/edit contact
 * screens (#27): the edited contact (when an id is given), every non-deleted
 * contact (duplicate detection — archived ones count) and the group names
 * (suggestions). Same staleness pattern as useContactsScreenData: one-shot
 * promises re-run on the storeManager data version.
 */
import { useEffect, useState, useSyncExternalStore } from "react";

import { createContactsRepository } from "@linky/evolu-store";
import type { ContactRecord, LinkyStore } from "@linky/evolu-store";

import { getStoreDataVersion, subscribeToStoreData } from "../store/storeManager";

export interface ContactEditorData {
  /** The edited contact; null on the add screen or when the id is unknown. */
  readonly record: ContactRecord | null;
  /** ALL non-deleted contacts (active + archived) — duplicate detection. */
  readonly contacts: ReadonlyArray<ContactRecord>;
  /** Distinct group names in use — suggestions. */
  readonly groups: ReadonlyArray<string>;
}

export type ContactEditorDataState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: ContactEditorData };

export const useContactEditorData = (
  store: LinkyStore | null,
  contactId: string | null,
): ContactEditorDataState => {
  const [state, setState] = useState<ContactEditorDataState>({ status: "loading" });
  const dataVersion = useSyncExternalStore(subscribeToStoreData, getStoreDataVersion);

  useEffect(() => {
    if (store === null) {
      setState({ status: "loading" });
      return;
    }
    let stale = false;
    const contactsRepo = createContactsRepository(store);
    void Promise.all([
      contactId === null ? Promise.resolve(null) : contactsRepo.findById(contactId),
      contactsRepo.list(),
      contactsRepo.listGroups(),
    ]).then(([record, contacts, groups]) => {
      if (stale) return;
      setState({ status: "ready", data: { record, contacts, groups } });
    });
    return () => {
      stale = true;
    };
  }, [store, contactId, dataVersion]);

  return state;
};
