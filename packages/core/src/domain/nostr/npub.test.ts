/**
 * npub input handling (#27): PoC-parity normalization + strict NIP-19
 * validation + npub -> hex bridging. The valid fixtures are the committed
 * dev identities (dev/test-identities/{alice,bob}.json).
 */
import { describe, expect, it } from "vitest";

import { isValidNpub, normalizeNpubIdentifier, npubToPublicKeyHex } from "./npub.js";

/** dev/test-identities/bob.json */
const BOB_NPUB = "npub1swl0lmqxtuz75j6chdq9p3lntq5ruf792458fhdty7wlm4kw7ecq47mgja";
const BOB_PUBKEY_HEX = "83beffec065f05ea4b58bb4050c7f358283e27c5556874ddab279dfdd6cef670";
/** dev/test-identities/alice.json */
const ALICE_NPUB = "npub1rteqaztwefwwlwyupkrx6wsmhkxa63qnkc2k38yuv9gnqsukdd7qw8qw9d";
const ALICE_PUBKEY_HEX = "1af20e896eca5cefb89c0d866d3a1bbd8ddd4413b615689c9c61513043966b7c";

describe("normalizeNpubIdentifier (PoC parity)", () => {
  it("trims and lowercases npub strings", () => {
    expect(normalizeNpubIdentifier(`  ${BOB_NPUB}  `)).toBe(BOB_NPUB);
    expect(normalizeNpubIdentifier(BOB_NPUB.toUpperCase())).toBe(BOB_NPUB);
  });

  it("strips a nostr: URI prefix (any case)", () => {
    expect(normalizeNpubIdentifier(`nostr:${BOB_NPUB}`)).toBe(BOB_NPUB);
    expect(normalizeNpubIdentifier(`NOSTR: ${BOB_NPUB}`)).toBe(BOB_NPUB);
  });

  it("unwraps the local part of an npub.cash address, rejecting other domains", () => {
    expect(normalizeNpubIdentifier(`${BOB_NPUB}@npub.cash`)).toBe(BOB_NPUB);
    expect(normalizeNpubIdentifier(`${BOB_NPUB}@NPUB.CASH`)).toBe(BOB_NPUB);
    expect(normalizeNpubIdentifier(`${BOB_NPUB}@getalby.com`)).toBeNull();
    expect(normalizeNpubIdentifier("@npub.cash")).toBeNull();
  });

  it("returns null for empty input and passes non-npub text through trimmed", () => {
    expect(normalizeNpubIdentifier("")).toBeNull();
    expect(normalizeNpubIdentifier("   ")).toBeNull();
    expect(normalizeNpubIdentifier(null)).toBeNull();
    expect(normalizeNpubIdentifier(undefined)).toBeNull();
    expect(normalizeNpubIdentifier("nostr:")).toBeNull();
    // Syntactic only: not-an-npub survives normalization (validation is separate).
    expect(normalizeNpubIdentifier(" hello world ")).toBe("hello world");
  });
});

describe("isValidNpub", () => {
  it("accepts checksum-valid npubs", () => {
    expect(isValidNpub(BOB_NPUB)).toBe(true);
    expect(isValidNpub(ALICE_NPUB)).toBe(true);
  });

  it("rejects bad checksums, wrong prefixes, and non-bech32 input", () => {
    expect(isValidNpub(BOB_NPUB.slice(0, -1) + "q")).toBe(false); // checksum broken
    expect(isValidNpub("npub1carolcarolcarolcarolcarolcarolcarolcarolcarolcarolcaseed")).toBe(
      false,
    );
    expect(isValidNpub("nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5")).toBe(
      false,
    ); // valid bech32, wrong prefix
    expect(isValidNpub("hello world")).toBe(false);
    expect(isValidNpub("")).toBe(false);
  });
});

describe("npubToPublicKeyHex", () => {
  it("decodes to the NIP-01 hex pubkey (golden: committed dev identities)", () => {
    expect(npubToPublicKeyHex(BOB_NPUB)).toBe(BOB_PUBKEY_HEX);
    expect(npubToPublicKeyHex(ALICE_NPUB)).toBe(ALICE_PUBKEY_HEX);
  });

  it("returns null for invalid input", () => {
    expect(npubToPublicKeyHex("npub1notvalid")).toBeNull();
    expect(npubToPublicKeyHex("")).toBeNull();
  });
});
