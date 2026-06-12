/**
 * NDEF record → scan value decoding (#50, `scanner.nfc-read`) — pure,
 * vitest-covered.
 *
 * An NFC tag read yields NDEF records ({ tnf, type, payload } byte shapes
 * from react-native-nfc-manager's `getTag()`); this module turns them into
 * plain strings for #48's unified parser (`routeScannedValue`). Kept
 * dependency-free on purpose: the NFC library only loads behind the
 * device-support gate (see ./nfcModule.ts), while decoding stays unit-
 * testable on Node.
 *
 * Supported record kinds (everything Linky or the PoC ever writes, plus the
 * common foreign-tag forms):
 * - Well-known URI ("U") — NFC Forum URI RTD: payload[0] indexes the
 *   abbreviation table below, the rest is UTF-8. Both Linky tag writes
 *   (`nostr://npub…`, `https://linky.fit/cashu/#…`) round-trip through this.
 * - Well-known Text ("T") — status byte (UTF-16 bit + language length),
 *   then the text. UTF-16 text records are skipped (no such writer in the
 *   wild for our payloads; a wrong-charset decode would corrupt the value).
 * - Absolute URI (TNF 3) — the whole payload is the URI.
 * - Media `text/plain` (TNF 2) — the whole payload is the text.
 *
 * Anything else decodes to `null` and the caller reports "no readable
 * value" — never a crash on a foreign tag.
 */

/** The record shape react-native-nfc-manager surfaces on `tag.ndefMessage`. */
export interface RawNdefRecord {
  readonly tnf: number;
  readonly type: ReadonlyArray<number> | string;
  readonly payload: ReadonlyArray<number>;
}

const TNF_WELL_KNOWN = 0x01;
const TNF_MEDIA = 0x02;
const TNF_ABSOLUTE_URI = 0x03;

/** NFC Forum URI RTD abbreviation table (payload byte 0 → prefix). */
export const NDEF_URI_PREFIXES: ReadonlyArray<string> = [
  "",
  "http://www.",
  "https://www.",
  "http://",
  "https://",
  "tel:",
  "mailto:",
  "ftp://anonymous:anonymous@",
  "ftp://ftp.",
  "ftps://",
  "sftp://",
  "smb://",
  "nfs://",
  "ftp://",
  "dav://",
  "news:",
  "telnet://",
  "imap:",
  "rtsp://",
  "urn:",
  "pop:",
  "sip:",
  "sips:",
  "tftp:",
  "btspp://",
  "btl2cap://",
  "btgoep://",
  "tcpobex://",
  "irdaobex://",
  "file://",
  "urn:epc:id:",
  "urn:epc:tag:",
  "urn:epc:pat:",
  "urn:epc:raw:",
  "urn:epc:",
  "urn:nfc:",
];

/**
 * Minimal UTF-8 decoder (no TextDecoder dependency — Hermes availability is
 * version-dependent). Malformed sequences decode as U+FFFD per convention;
 * the scan parser rejects garbage downstream anyway.
 */
export const utf8BytesToString = (bytes: ReadonlyArray<number>): string => {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b0 = (bytes[i] ?? 0) & 0xff;
    let codePoint: number;
    let extra: number;
    if (b0 < 0x80) {
      codePoint = b0;
      extra = 0;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      codePoint = b0 & 0x1f;
      extra = 1;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      codePoint = b0 & 0x0f;
      extra = 2;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      codePoint = b0 & 0x07;
      extra = 3;
    } else {
      out += "�";
      i += 1;
      continue;
    }
    if (i + extra >= bytes.length) {
      // Truncated trailing sequence.
      out += "�";
      break;
    }
    let valid = true;
    for (let k = 1; k <= extra; k += 1) {
      const bk = (bytes[i + k] ?? 0) & 0xff;
      if (bk < 0x80 || bk > 0xbf) {
        valid = false;
        break;
      }
      codePoint = (codePoint << 6) | (bk & 0x3f);
    }
    if (!valid) {
      out += "�";
      i += 1;
      continue;
    }
    out += String.fromCodePoint(codePoint);
    i += extra + 1;
  }
  return out;
};

/** Record type as text ("U", "T", "text/plain") whatever shape it arrived in. */
const typeText = (type: RawNdefRecord["type"]): string =>
  typeof type === "string" ? type : utf8BytesToString(type);

const decodeUriRecord = (payload: ReadonlyArray<number>): string | null => {
  if (payload.length < 2) return null;
  const prefix = NDEF_URI_PREFIXES[(payload[0] ?? 0) & 0xff] ?? "";
  return prefix + utf8BytesToString(payload.slice(1));
};

const decodeTextRecord = (payload: ReadonlyArray<number>): string | null => {
  if (payload.length < 1) return null;
  const status = (payload[0] ?? 0) & 0xff;
  const isUtf16 = (status & 0x80) !== 0;
  if (isUtf16) return null; // see module doc — never guess a charset
  const langLength = status & 0x3f;
  if (1 + langLength >= payload.length) return null;
  return utf8BytesToString(payload.slice(1 + langLength));
};

/**
 * Decodes one NDEF record into a candidate scan string, or `null` when the
 * record kind is not value-bearing.
 */
export const decodeNdefRecordValue = (record: RawNdefRecord): string | null => {
  const payload = record.payload ?? [];
  switch (record.tnf) {
    case TNF_WELL_KNOWN: {
      const type = typeText(record.type);
      if (type === "U") return decodeUriRecord(payload);
      if (type === "T") return decodeTextRecord(payload);
      return null;
    }
    case TNF_ABSOLUTE_URI:
      return payload.length > 0 ? utf8BytesToString(payload) : null;
    case TNF_MEDIA: {
      const type = typeText(record.type).toLowerCase();
      if (type === "text/plain" || type.startsWith("text/plain;")) {
        return payload.length > 0 ? utf8BytesToString(payload) : null;
      }
      return null;
    }
    default:
      return null;
  }
};

/**
 * The value a tag read feeds into the unified parser: the first record that
 * decodes to a non-empty string (tags Linky writes carry exactly one URI
 * record; foreign multi-record tags get their leading value).
 */
export const firstNdefScanValue = (
  records: ReadonlyArray<RawNdefRecord> | null | undefined,
): string | null => {
  for (const record of records ?? []) {
    const decoded = decodeNdefRecordValue(record);
    if (decoded !== null && decoded.trim() !== "") return decoded.trim();
  }
  return null;
};
