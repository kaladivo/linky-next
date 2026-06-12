/**
 * NDEF record decoding (#50, `scanner.nfc-read`). Byte fixtures are
 * hand-built per the NFC Forum URI/Text RTDs (the same wire format
 * react-native-nfc-manager's `Ndef.uriRecord` writes — prefix-compressed
 * URI records), so a Linky-written tag round-trips through this decoder.
 */
import { describe, expect, it } from "vitest";

import type { RawNdefRecord } from "./ndefValues";
import { decodeNdefRecordValue, firstNdefScanValue, utf8BytesToString } from "./ndefValues";

const ascii = (text: string): number[] => [...text].map((ch) => ch.charCodeAt(0));

/** Well-known URI record ("U") with an abbreviation-table prefix byte. */
const uriRecord = (prefixCode: number, rest: string): RawNdefRecord => ({
  tnf: 0x01,
  type: ascii("U"),
  payload: [prefixCode, ...ascii(rest)],
});

/** Well-known Text record ("T"): status byte + language code + text. */
const textRecord = (text: string, lang = "en", utf16 = false): RawNdefRecord => ({
  tnf: 0x01,
  type: "T",
  payload: [(utf16 ? 0x80 : 0x00) | lang.length, ...ascii(lang), ...ascii(text)],
});

describe("utf8BytesToString", () => {
  it("decodes multi-byte sequences", () => {
    // "Kč" = 0x4B + U+010D (0xC4 0x8D); "€" = 0xE2 0x82 0xAC.
    expect(utf8BytesToString([0x4b, 0xc4, 0x8d])).toBe("Kč");
    expect(utf8BytesToString([0xe2, 0x82, 0xac])).toBe("€");
  });

  it("replaces malformed/truncated bytes instead of throwing", () => {
    expect(utf8BytesToString([0x41, 0xff, 0x42])).toBe("A�B");
    expect(utf8BytesToString([0x41, 0xe2, 0x82])).toBe("A�");
  });
});

describe("decodeNdefRecordValue", () => {
  it("decodes URI records with the identity prefix (what Linky writes)", () => {
    // Ndef.uriRecord("nostr://npub1…") finds no table prefix → code 0x00.
    expect(decodeNdefRecordValue(uriRecord(0x00, "nostr://npub1xyz"))).toBe("nostr://npub1xyz");
  });

  it("expands abbreviation-table prefixes (0x04 = https://)", () => {
    expect(decodeNdefRecordValue(uriRecord(0x04, "linky.fit/cashu/#cashuB123"))).toBe(
      "https://linky.fit/cashu/#cashuB123",
    );
    expect(decodeNdefRecordValue(uriRecord(0x02, "linky.fit"))).toBe("https://www.linky.fit");
  });

  it("treats unknown prefix codes as identity instead of failing", () => {
    expect(decodeNdefRecordValue(uriRecord(0x7f, "cashu:token"))).toBe("cashu:token");
  });

  it("decodes UTF-8 text records, skipping the language code", () => {
    expect(decodeNdefRecordValue(textRecord("cashuBdead", "en"))).toBe("cashuBdead");
    expect(decodeNdefRecordValue(textRecord("npub1xyz", "cs"))).toBe("npub1xyz");
  });

  it("skips UTF-16 text records (never guesses a charset)", () => {
    expect(decodeNdefRecordValue(textRecord("npub1xyz", "en", true))).toBeNull();
  });

  it("decodes absolute-URI (TNF 3) and text/plain media (TNF 2) records", () => {
    expect(
      decodeNdefRecordValue({ tnf: 0x03, type: [], payload: ascii("lightning:lnbc1abc") }),
    ).toBe("lightning:lnbc1abc");
    expect(
      decodeNdefRecordValue({ tnf: 0x02, type: "text/plain", payload: ascii("npub1xyz") }),
    ).toBe("npub1xyz");
    expect(
      decodeNdefRecordValue({
        tnf: 0x02,
        type: "text/plain;charset=UTF-8",
        payload: ascii("npub1xyz"),
      }),
    ).toBe("npub1xyz");
  });

  it("returns null for non-value records and degenerate payloads", () => {
    // Media record of a foreign type.
    expect(
      decodeNdefRecordValue({ tnf: 0x02, type: "image/png", payload: [1, 2, 3] }),
    ).toBeNull();
    // Well-known but neither U nor T (e.g. Smart Poster "Sp").
    expect(decodeNdefRecordValue({ tnf: 0x01, type: "Sp", payload: [1] })).toBeNull();
    // Empty / too-short payloads.
    expect(decodeNdefRecordValue({ tnf: 0x01, type: "U", payload: [] })).toBeNull();
    expect(decodeNdefRecordValue({ tnf: 0x01, type: "U", payload: [0x00] })).toBeNull();
    expect(decodeNdefRecordValue({ tnf: 0x01, type: "T", payload: [] })).toBeNull();
    expect(decodeNdefRecordValue({ tnf: 0x01, type: "T", payload: [0x02, 0x65] })).toBeNull();
    expect(decodeNdefRecordValue({ tnf: 0x03, type: [], payload: [] })).toBeNull();
    // Empty (TNF 0) and unknown (TNF 5) records.
    expect(decodeNdefRecordValue({ tnf: 0x00, type: [], payload: [] })).toBeNull();
    expect(decodeNdefRecordValue({ tnf: 0x05, type: [], payload: ascii("x") })).toBeNull();
  });
});

describe("firstNdefScanValue", () => {
  it("returns the first value-bearing record, trimmed", () => {
    const records: RawNdefRecord[] = [
      { tnf: 0x00, type: [], payload: [] }, // empty record first
      textRecord("  npub1xyz  "),
      uriRecord(0x04, "linky.fit"),
    ];
    expect(firstNdefScanValue(records)).toBe("npub1xyz");
  });

  it("returns null for missing, empty, or valueless messages", () => {
    expect(firstNdefScanValue(null)).toBeNull();
    expect(firstNdefScanValue(undefined)).toBeNull();
    expect(firstNdefScanValue([])).toBeNull();
    expect(firstNdefScanValue([{ tnf: 0x01, type: "T", payload: [0x02, 0x65, 0x6e] }])).toBeNull();
  });
});
