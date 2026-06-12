/**
 * contactFormModel — pure logic behind the add/edit contact screens (#27,
 * `contacts.add` / `contacts.edit` / `contacts.refresh-nostr`).
 *
 * No React, no Evolu. PoC-matching behaviors pinned by
 * `contactFormModel.test.ts`:
 *
 * - Validation (PoC `handleSaveContact`): all fields trimmed, npub
 *   normalized (`nostr:` URI, npub.cash address, case); at least one of
 *   name/npub/Lightning address required; saving your own npub is refused.
 *   On top of the PoC, a present npub must be checksum-valid bech32 (issue
 *   #27) — except an UNCHANGED npub on edit, so legacy/seed rows with
 *   free-text npubs stay editable.
 * - Duplicate detection (feature-map contract "no duplicate npubs or
 *   Lightning addresses"): normalized-npub match first (the PoC's check),
 *   then case-insensitive Lightning-address match. Archived contacts
 *   count — the conflict UX opens them so the user can restore instead.
 * - Edit savability + minimal patches (PoC: only changed fields are
 *   written, to keep sync history small).
 * - Refresh-from-Nostr field rules (PoC `refreshContactFromNostr`): a found
 *   kind-0 overwrites `name` (display_name ?? name) and `lnAddress`
 *   (lud16 ?? lud06) directly — absent metadata fields leave the stored
 *   value untouched; the npub is canonicalized if the stored form differed.
 * - Group suggestions: case-insensitive substring filter over the existing
 *   group names (the PoC's <datalist>), hiding an exact match.
 */
import {
  bestProfileName,
  isValidNpub,
  normalizeNpubIdentifier,
  profileLightningAddress,
} from "@linky/core";
import type { NostrProfileMetadata } from "@linky/core";
import type { ContactPatch, ContactRecord } from "@linky/evolu-store";

// ─── Form state ──────────────────────────────────────────────────────────

/** The four text inputs, raw (untrimmed) as the user typed them. */
export interface ContactFormState {
  readonly name: string;
  readonly npub: string;
  readonly lnAddress: string;
  readonly group: string;
}

export const emptyContactForm = (): ContactFormState => ({
  name: "",
  npub: "",
  lnAddress: "",
  group: "",
});

export const formFromRecord = (record: ContactRecord): ContactFormState => ({
  name: record.name ?? "",
  npub: record.npub ?? "",
  lnAddress: record.lnAddress ?? "",
  group: record.groupName ?? "",
});

/** Cleaned values ready for the repository; `null` = field empty. */
export interface ContactFormValues {
  readonly name: string | null;
  readonly npub: string | null;
  readonly lnAddress: string | null;
  readonly groupName: string | null;
}

// ─── Validation (contacts.add / contacts.edit) ───────────────────────────

export type ContactFormValidation =
  /** Nothing identifying filled in (PoC `fillAtLeastOne`). */
  | { readonly kind: "empty" }
  /** npub present but not checksum-valid bech32 (issue #27 validation). */
  | { readonly kind: "invalidNpub" }
  /** The npub is the user's own profile (PoC `contactIsYou`). */
  | { readonly kind: "self" }
  | { readonly kind: "valid"; readonly values: ContactFormValues };

export interface ValidateContactFormOptions {
  /** The active identity's npub — saving yourself is refused. */
  readonly ownNpub: string | null;
  /**
   * The stored npub when editing; an UNCHANGED npub skips bech32
   * validation so pre-#27 rows with non-bech32 npubs remain editable.
   */
  readonly originalNpub?: string | null;
}

const normalizedOrTrimmed = (raw: string): string => {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  return normalizeNpubIdentifier(trimmed) ?? trimmed;
};

export const validateContactForm = (
  form: ContactFormState,
  options: ValidateContactFormOptions,
): ContactFormValidation => {
  const name = form.name.trim();
  const npub = normalizedOrTrimmed(form.npub);
  const lnAddress = form.lnAddress.trim();
  const groupName = form.group.trim();

  if (name === "" && npub === "" && lnAddress === "") return { kind: "empty" };

  if (npub !== "") {
    const original = normalizedOrTrimmed(options.originalNpub ?? "");
    const unchanged = original !== "" && npub === original;
    if (!unchanged && !isValidNpub(npub)) return { kind: "invalidNpub" };

    const own = normalizeNpubIdentifier(options.ownNpub);
    if (own !== null && npub === own) return { kind: "self" };
  }

  return {
    kind: "valid",
    values: {
      name: name === "" ? null : name,
      npub: npub === "" ? null : npub,
      lnAddress: lnAddress === "" ? null : lnAddress,
      groupName: groupName === "" ? null : groupName,
    },
  };
};

// ─── Duplicate detection ─────────────────────────────────────────────────

/**
 * The existing contact the new values collide with, or null. npub matches
 * (normalized, the PoC's check) win over Lightning-address matches
 * (case-insensitive — feature-map contract). `excludeId` skips the contact
 * being edited.
 */
export const findDuplicateContact = (
  contacts: ReadonlyArray<ContactRecord>,
  values: { readonly npub: string | null; readonly lnAddress: string | null },
  excludeId?: string | null,
): ContactRecord | null => {
  const candidates = contacts.filter((contact) => contact.id !== excludeId);

  if (values.npub !== null) {
    const byNpub = candidates.find(
      (contact) => normalizeNpubIdentifier(contact.npub) === values.npub,
    );
    if (byNpub !== undefined) return byNpub;
  }

  if (values.lnAddress !== null) {
    const needle = values.lnAddress.toLowerCase();
    const byLn = candidates.find(
      (contact) => (contact.lnAddress ?? "").trim().toLowerCase() === needle,
    );
    if (byLn !== undefined) return byLn;
  }

  return null;
};

// ─── Edit savability + minimal patch (PoC parity) ────────────────────────

const trimmedEquals = (a: string, b: string): boolean => a.trim() === b.trim();

/** True when the form differs from the stored record (any field, trimmed). */
export const isContactFormDirty = (initial: ContactFormState, form: ContactFormState): boolean =>
  !trimmedEquals(initial.name, form.name) ||
  !trimmedEquals(initial.npub, form.npub) ||
  !trimmedEquals(initial.lnAddress, form.lnAddress) ||
  !trimmedEquals(initial.group, form.group);

/** PoC `contactEditsSavable`: dirty AND still identifying somebody. */
export const isContactEditSavable = (
  initial: ContactFormState,
  form: ContactFormState,
): boolean => {
  const hasRequired =
    form.name.trim() !== "" || form.npub.trim() !== "" || form.lnAddress.trim() !== "";
  return hasRequired && isContactFormDirty(initial, form);
};

/**
 * The minimal repository patch turning `initial` into `values` — only
 * changed fields are present (PoC: keeps sync history entries small).
 * `{}` means nothing changed.
 */
export const contactPatchFromValues = (
  initial: ContactFormValues,
  values: ContactFormValues,
): ContactPatch => ({
  ...(initial.name !== values.name ? { name: values.name } : {}),
  ...(initial.npub !== values.npub ? { npub: values.npub } : {}),
  ...(initial.lnAddress !== values.lnAddress ? { lnAddress: values.lnAddress } : {}),
  ...(initial.groupName !== values.groupName ? { groupName: values.groupName } : {}),
});

export const valuesFromRecord = (record: ContactRecord): ContactFormValues => ({
  name: record.name,
  npub: record.npub,
  lnAddress: record.lnAddress,
  groupName: record.groupName,
});

// ─── Refresh from Nostr (contacts.refresh-nostr) ─────────────────────────

/**
 * The repository patch an explicit refresh applies for a fetched kind-0
 * (PoC `refreshContactFromNostr` field rules): overwrite name and
 * Lightning address with the published values WHEN PRESENT (no
 * confirmation step — refresh is an explicit user action), keep stored
 * values for absent fields, and canonicalize the npub if the stored form
 * differed (e.g. `nostr:` prefix or uppercase).
 */
export const nostrRefreshPatch = (
  storedNpub: string,
  metadata: NostrProfileMetadata,
): ContactPatch => {
  const name = bestProfileName(metadata);
  const lnAddress = profileLightningAddress(metadata);
  const trimmed = storedNpub.trim();
  const normalized = normalizeNpubIdentifier(trimmed);
  return {
    ...(name !== null ? { name } : {}),
    ...(lnAddress !== null ? { lnAddress } : {}),
    ...(normalized !== null && normalized !== trimmed ? { npub: normalized } : {}),
  };
};

// ─── Group suggestions (PoC <datalist>) ──────────────────────────────────

export const MAX_GROUP_SUGGESTIONS = 8;

/**
 * Existing group names matching the input (case-insensitive substring; all
 * of them while the input is empty), minus an exact match — once the field
 * equals a group there is nothing left to suggest.
 */
export const filterGroupSuggestions = (
  groups: ReadonlyArray<string>,
  input: string,
  limit: number = MAX_GROUP_SUGGESTIONS,
): ReadonlyArray<string> => {
  const needle = input.trim().toLowerCase();
  return groups
    .filter((group) => {
      const haystack = group.toLowerCase();
      if (haystack === needle) return false;
      return needle === "" || haystack.includes(needle);
    })
    .slice(0, limit);
};
