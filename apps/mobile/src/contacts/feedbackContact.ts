/**
 * Feedback contact (#26, `contacts.feedback`): a hard-coded contact for
 * feedback/donations, reachable from the menu (Settings screen — the PoC's
 * ☰ menu maps to the pushed Settings screen in this shell).
 *
 * PoC behavior, kept: the contact is saved WITHOUT a name (the deterministic
 * default name for the npub displays instead, localized), found by npub if
 * it already exists, created on first open.
 */
import { createContactsRepository } from "@linky/evolu-store";
import type { LinkyStore } from "@linky/evolu-store";

import { invalidateStoreData } from "../store/storeManager";

/** The PoC's hard-coded feedback npub (linky-poc `FEEDBACK_CONTACT_NPUB`). */
export const FEEDBACK_CONTACT_NPUB =
  "npub1kkht6jvgr8mt4844saf80j5jjwyy6fdy90sxsuxt4hfv8pel499s96jvz8";

/**
 * Finds or creates the feedback contact; resolves with the contact id the
 * caller routes to (chat/[id]). Rejects only on a storage-level bug — the
 * hard-coded payload cannot fail validation.
 */
export const openFeedbackContact = async (store: LinkyStore): Promise<{ id: string }> => {
  const contacts = createContactsRepository(store);
  const existing = await contacts.findByNpub(FEEDBACK_CONTACT_NPUB);
  if (existing !== null) return { id: existing.id };

  const inserted = contacts.insert({ npub: FEEDBACK_CONTACT_NPUB });
  if (!inserted.ok) {
    throw new Error(`feedback contact insert failed: ${inserted.error.reason}`);
  }
  invalidateStoreData();
  return { id: inserted.value.id };
};
