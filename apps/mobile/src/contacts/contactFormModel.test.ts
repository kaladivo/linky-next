/**
 * contactFormModel tests (#27) — npub validation, duplicate detection,
 * minimal patches, refresh-from-Nostr field rules, group suggestions.
 */
import type { ContactRecord } from "@linky/evolu-store";
import { describe, expect, it } from "vitest";

import {
  contactPatchFromValues,
  emptyContactForm,
  filterGroupSuggestions,
  findDuplicateContact,
  formFromRecord,
  isContactEditSavable,
  isContactFormDirty,
  nostrRefreshPatch,
  validateContactForm,
  valuesFromRecord,
} from "./contactFormModel";

/** dev/test-identities/bob.json — a real, checksum-valid npub. */
const BOB_NPUB = "npub1swl0lmqxtuz75j6chdq9p3lntq5ruf792458fhdty7wlm4kw7ecq47mgja";
/** dev/test-identities/alice.json — "own" identity in these tests. */
const ALICE_NPUB = "npub1rteqaztwefwwlwyupkrx6wsmhkxa63qnkc2k38yuv9gnqsukdd7qw8qw9d";

const record = (overrides: Partial<ContactRecord> & { readonly id: string }): ContactRecord => ({
  name: null,
  npub: null,
  lnAddress: null,
  groupName: null,
  archivedAtSec: null,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: null,
  ...overrides,
});

const form = (overrides: Partial<ReturnType<typeof emptyContactForm>>) => ({
  ...emptyContactForm(),
  ...overrides,
});

describe("validateContactForm", () => {
  const options = { ownNpub: ALICE_NPUB };

  it("requires at least one of name / npub / Lightning address (PoC fillAtLeastOne)", () => {
    expect(validateContactForm(form({ group: "Friends" }), options)).toEqual({ kind: "empty" });
    expect(validateContactForm(form({ name: "  " }), options)).toEqual({ kind: "empty" });
    expect(validateContactForm(form({ name: "Bob" }), options).kind).toBe("valid");
  });

  it("normalizes the npub (nostr: URI, npub.cash, case) and trims everything", () => {
    const result = validateContactForm(
      form({
        name: "  Bob  ",
        npub: ` nostr:${BOB_NPUB.toUpperCase()} `,
        lnAddress: " bob@npub.cash ",
        group: " Friends ",
      }),
      options,
    );
    expect(result).toEqual({
      kind: "valid",
      values: {
        name: "Bob",
        npub: BOB_NPUB,
        lnAddress: "bob@npub.cash",
        groupName: "Friends",
      },
    });
  });

  it("rejects a checksum-invalid npub", () => {
    expect(validateContactForm(form({ npub: "npub1nonsense" }), options)).toEqual({
      kind: "invalidNpub",
    });
    expect(validateContactForm(form({ npub: "not an npub at all" }), options)).toEqual({
      kind: "invalidNpub",
    });
  });

  it("keeps an UNCHANGED non-bech32 npub editable (legacy/seed rows)", () => {
    const legacy = "npub1carolcarolcarolcarolcarolcarolcarolcarolcarolcarolcaseed";
    expect(
      validateContactForm(form({ name: "Carol", npub: legacy }), {
        ownNpub: ALICE_NPUB,
        originalNpub: legacy,
      }).kind,
    ).toBe("valid");
    // ...but CHANGING it to another invalid npub is rejected.
    expect(
      validateContactForm(form({ npub: "npub1different" }), {
        ownNpub: ALICE_NPUB,
        originalNpub: legacy,
      }),
    ).toEqual({ kind: "invalidNpub" });
  });

  it("refuses the user's own npub (PoC contactIsYou)", () => {
    expect(validateContactForm(form({ npub: ALICE_NPUB }), options)).toEqual({ kind: "self" });
    expect(validateContactForm(form({ npub: `nostr:${ALICE_NPUB}` }), options)).toEqual({
      kind: "self",
    });
  });
});

describe("findDuplicateContact", () => {
  const bob = record({ id: "c-bob", name: "Bob", npub: BOB_NPUB });
  const carol = record({ id: "c-carol", name: "Carol", lnAddress: "Carol@GetAlby.com" });
  const contacts = [bob, carol];

  it("matches an existing npub after normalization (PoC dedup)", () => {
    expect(findDuplicateContact(contacts, { npub: BOB_NPUB, lnAddress: null })).toBe(bob);
  });

  it("matches an existing Lightning address case-insensitively", () => {
    expect(
      findDuplicateContact(contacts, { npub: null, lnAddress: "carol@getalby.com" }),
    ).toBe(carol);
  });

  it("prefers the npub match when both would collide", () => {
    expect(
      findDuplicateContact(contacts, { npub: BOB_NPUB, lnAddress: "carol@getalby.com" }),
    ).toBe(bob);
  });

  it("excludes the contact being edited and returns null when unique", () => {
    expect(findDuplicateContact(contacts, { npub: BOB_NPUB, lnAddress: null }, "c-bob")).toBeNull();
    expect(findDuplicateContact(contacts, { npub: null, lnAddress: "new@addr.com" })).toBeNull();
    expect(findDuplicateContact(contacts, { npub: null, lnAddress: null })).toBeNull();
  });
});

describe("edit savability + minimal patch (PoC parity)", () => {
  const stored = record({ id: "c-1", name: "Bob", npub: BOB_NPUB, groupName: "Friends" });
  const initial = formFromRecord(stored);

  it("is savable only when dirty AND still identifying somebody", () => {
    expect(isContactEditSavable(initial, initial)).toBe(false); // clean
    expect(isContactEditSavable(initial, { ...initial, name: "Bobby" })).toBe(true);
    expect(isContactEditSavable(initial, { ...initial, name: "Bob " })).toBe(false); // trim-equal
    // All identifying fields cleared -> not savable even though dirty.
    expect(isContactEditSavable(initial, form({ group: "Friends" }))).toBe(false);
    expect(isContactFormDirty(initial, { ...initial, group: "Work" })).toBe(true);
  });

  it("patches only the changed fields, clearing with null", () => {
    const next = { name: "Bobby", npub: BOB_NPUB, lnAddress: null, groupName: null };
    expect(contactPatchFromValues(valuesFromRecord(stored), next)).toEqual({
      name: "Bobby",
      groupName: null,
    });
    expect(contactPatchFromValues(valuesFromRecord(stored), valuesFromRecord(stored))).toEqual({});
  });
});

describe("nostrRefreshPatch (PoC refresh field rules)", () => {
  it("overwrites name and Lightning address with the published values", () => {
    expect(
      nostrRefreshPatch(BOB_NPUB, {
        name: "bob",
        displayName: "Bob on Nostr",
        lud16: "bob@getalby.com",
        lud06: "lnurl1ignored",
      }),
    ).toEqual({ name: "Bob on Nostr", lnAddress: "bob@getalby.com" });
  });

  it("leaves stored fields alone when the metadata lacks them", () => {
    expect(nostrRefreshPatch(BOB_NPUB, { picture: "https://example.com/a.png" })).toEqual({});
    expect(nostrRefreshPatch(BOB_NPUB, { lud06: "lnurl1fallback" })).toEqual({
      lnAddress: "lnurl1fallback",
    });
  });

  it("canonicalizes a non-canonical stored npub", () => {
    expect(nostrRefreshPatch(`nostr:${BOB_NPUB}`, { name: "Bob" })).toEqual({
      name: "Bob",
      npub: BOB_NPUB,
    });
    expect(nostrRefreshPatch(BOB_NPUB, { name: "Bob" })).toEqual({ name: "Bob" });
  });
});

describe("filterGroupSuggestions", () => {
  const groups = ["Family", "Friends", "Work"];

  it("shows everything while the input is empty", () => {
    expect(filterGroupSuggestions(groups, "")).toEqual(groups);
    expect(filterGroupSuggestions(groups, "   ")).toEqual(groups);
  });

  it("filters by case-insensitive substring", () => {
    expect(filterGroupSuggestions(groups, "f")).toEqual(["Family", "Friends"]);
    expect(filterGroupSuggestions(groups, "RIE")).toEqual(["Friends"]);
    expect(filterGroupSuggestions(groups, "zzz")).toEqual([]);
  });

  it("hides an exact (case-insensitive) match and respects the cap", () => {
    expect(filterGroupSuggestions(groups, "friends")).toEqual([]);
    expect(filterGroupSuggestions(["A1", "A2", "A3"], "a", 2)).toEqual(["A1", "A2"]);
  });
});
