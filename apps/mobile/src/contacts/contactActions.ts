/**
 * contactActions — repository writes + the Nostr refresh behind the
 * add/edit contact screens (#27). Thin impure shell over the pure rules in
 * `contactFormModel.ts`; every mutation calls `invalidateStoreData()` so
 * mounted lists re-query (storeManager contract).
 *
 * Repository write errors are thrown as defects on purpose: by the time an
 * action runs, the values passed validation — a failing write means a bug,
 * not a user-fixable state (same stance as feedbackContact.ts).
 */
import { fetchProfileMetadata, normalizeNpubIdentifier, npubToPublicKeyHex } from "@linky/core";
import { createContactsRepository } from "@linky/evolu-store";
import type { ContactPatch, LinkyStore } from "@linky/evolu-store";
import { Effect, Option } from "effect";
import type { Duration } from "effect";

import { runAppEffect } from "../runtime";
import { invalidateStoreData } from "../store/storeManager";
import { nostrRefreshPatch } from "./contactFormModel";
import type { ContactFormValues } from "./contactFormModel";

/** Creates a contact (`contacts.add`); resolves with the new id. */
export const insertContact = (store: LinkyStore, values: ContactFormValues): { id: string } => {
  const contacts = createContactsRepository(store);
  const inserted = contacts.insert({
    ...(values.name !== null ? { name: values.name } : {}),
    ...(values.npub !== null ? { npub: values.npub } : {}),
    ...(values.lnAddress !== null ? { lnAddress: values.lnAddress } : {}),
    ...(values.groupName !== null ? { groupName: values.groupName } : {}),
  });
  if (!inserted.ok) throw new Error(`contact insert failed: ${inserted.error.reason}`);
  invalidateStoreData();
  return { id: inserted.value.id };
};

/** Applies a (non-empty) patch to a contact (`contacts.edit`). */
export const updateContact = (store: LinkyStore, id: string, patch: ContactPatch): void => {
  if (Object.keys(patch).length === 0) return;
  const contacts = createContactsRepository(store);
  const updated = contacts.update(id, patch);
  if (!updated.ok) throw new Error(`contact update failed: ${updated.error._tag}`);
  invalidateStoreData();
};

/** `contacts.archive`: stamps archivedAtSec — never touches history. */
export const archiveContact = (store: LinkyStore, id: string): void => {
  updateContact(store, id, { archivedAtSec: Math.ceil(Date.now() / 1000) });
};

/** Un-archive (PoC `restoreArchivedContact`). */
export const unarchiveContact = (store: LinkyStore, id: string): void => {
  updateContact(store, id, { archivedAtSec: null });
};

export type NostrRefreshOutcome =
  /** The contact has no (decodable) npub — nothing to fetch. */
  | { readonly kind: "no-npub" }
  /** No kind-0 found on the relays (or offline). */
  | { readonly kind: "no-profile" }
  /** Metadata found; `patch` is what was written (may be empty). */
  | { readonly kind: "refreshed"; readonly patch: ContactPatch };

/**
 * Hard ceiling on a refresh round trip. The fetch already bounds its relay
 * collection window, but relay/socket work can stall past it (observed on
 * the simulator: the subscribe stream never ends when no relay connection
 * comes up) — the button must always settle (toast path), so the whole
 * workflow races this timeout and a loss counts as `no-profile`. The fetch
 * runs `disconnect`ed: on timeout it is interrupted in the BACKGROUND, so
 * a fetch stuck in socket setup cannot also hang the interruption.
 */
const REFRESH_TIMEOUT: Duration.DurationInput = "20 seconds";

/**
 * `contacts.refresh-nostr`: fetches the contact's kind-0 PAST the cache
 * (explicit user action) and applies the PoC field rules
 * (`nostrRefreshPatch`). The fetch itself never fails — offline or timed
 * out resolves as `no-profile`.
 */
export const refreshContactFromNostr = async (
  store: LinkyStore,
  contact: { readonly id: string; readonly npub: string | null },
): Promise<NostrRefreshOutcome> => {
  const normalized = normalizeNpubIdentifier(contact.npub);
  const pubkeyHex = normalized === null ? null : npubToPublicKeyHex(normalized);
  if (pubkeyHex === null) return { kind: "no-npub" };

  const metadata = await runAppEffect(
    Effect.log(`contacts.refresh-nostr: fetching kind-0 for ${pubkeyHex.slice(0, 8)}…`).pipe(
      Effect.andThen(Effect.disconnect(fetchProfileMetadata(pubkeyHex, { ignoreCache: true }))),
      Effect.timeoutTo({
        duration: REFRESH_TIMEOUT,
        onTimeout: Option.none,
        onSuccess: (value) => value,
      }),
      Effect.tap((result) =>
        Effect.log(`contacts.refresh-nostr: ${Option.isSome(result) ? "metadata found" : "none"}`),
      ),
    ),
  );
  if (Option.isNone(metadata)) return { kind: "no-profile" };

  const patch = nostrRefreshPatch(contact.npub ?? "", metadata.value);
  updateContact(store, contact.id, patch);
  return { kind: "refreshed", patch };
};

/**
 * Background metadata warm-up after saving a contact (PoC: saving with an
 * npub kicks off a profile fetch so the avatar/name cache is ready).
 * Cache-first and fire-and-forget — failures are impossible by contract.
 */
export const prefetchContactProfile = (npub: string): void => {
  const normalized = normalizeNpubIdentifier(npub);
  const pubkeyHex = normalized === null ? null : npubToPublicKeyHex(normalized);
  if (pubkeyHex === null) return;
  void runAppEffect(fetchProfileMetadata(pubkeyHex));
};
