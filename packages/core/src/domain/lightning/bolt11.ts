/**
 * BOLT11 invoice parsing — pure, RN-compatible, no native deps.
 *
 * Ported from the PoC's hand-rolled parser
 * (`apps/web-app/src/utils/lightningInvoice.ts`): amount from the bech32 HRP,
 * description (`d`), description hash (`h`) and expiry (`x`) from the tagged
 * fields, decoded with `@scure/base` bech32 (the PoC's only bolt11
 * dependency). Semantics are pinned by `__fixtures__/lightning.golden.json`.
 * Additions over the PoC: payment hash (`p` tag), network classification and
 * the invoice timestamp.
 *
 * Deliberately lenient, like the PoC: anything carrying a valid `ln*` HRP
 * prefix parses (so the UI can always show a confirmation screen); fields the
 * payload does not yield stay `null`. Signatures are NOT verified — paying
 * happens via a mint melt, which performs its own validation.
 *
 * Intentional divergence from the PoC (see `__fixtures__/README.md`): the
 * prefix alternation orders `lnbcrt` before `lnbc`, so regtest amounts parse
 * instead of falling back to amountless.
 */
import { bech32, utf8 } from "@scure/base";
import { Effect } from "effect";

import { InvalidBolt11InvoiceError } from "./errors.js";

/** `lnbcrt` must precede `lnbc` (PoC ordered them the other way — a bug). */
const BOLT11_PREFIX_RE = /^(lnbcrt|lnbc|lntb)/i;
const BOLT11_WORD_LIMIT = 5_000;
const BOLT11_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BOLT11_TIMESTAMP_WORDS = 7;
const BOLT11_SIGNATURE_WORDS = 104;
/** BOLT11: invoices without an `x` tag default to 1 hour expiry. */
const DEFAULT_EXPIRY_SECONDS = 3_600;

const PAYMENT_HASH_TAG = BOLT11_CHARSET.indexOf("p");
const DESCRIPTION_TAG = BOLT11_CHARSET.indexOf("d");
const DESCRIPTION_HASH_TAG = BOLT11_CHARSET.indexOf("h");
const EXPIRY_TAG = BOLT11_CHARSET.indexOf("x");

export type Bolt11Network = "mainnet" | "testnet" | "regtest";

export interface Bolt11Invoice {
  /** The trimmed invoice text as given. */
  readonly invoice: string;
  readonly network: Bolt11Network;
  /** `null` = amountless invoice. */
  readonly amountMsat: number | null;
  /** Ceiling of `amountMsat / 1000` (PoC semantics); `null` when amountless. */
  readonly amountSat: number | null;
  /** `d` tag (memo); `null` when absent or only a description hash is set. */
  readonly description: string | null;
  /** `h` tag — sha256 of the LNURL-pay metadata for LUD-06 invoices. */
  readonly descriptionHashHex: string | null;
  /** `p` tag. */
  readonly paymentHashHex: string | null;
  /** Invoice creation time (unix seconds). */
  readonly timestampSec: number | null;
  /** `timestampSec + (x tag ?? 3600)`; `null` when the timestamp is unreadable. */
  readonly expiresAtSec: number | null;
}

const networkOf = (prefix: string): Bolt11Network => {
  switch (prefix.toLowerCase()) {
    case "lnbcrt":
      return "regtest";
    case "lntb":
      return "testnet";
    default:
      return "mainnet";
  }
};

/**
 * Millisatoshi amount from the HRP, or `null` for amountless invoices (and
 * anything that is not a bolt11 string at all). Exact PoC semantics
 * (including `Math.ceil` of fractional pico amounts), modulo the `lnbcrt`
 * ordering fix.
 */
export const parseBolt11AmountMsat = (invoice: string): number | null => {
  const separatorIndex = invoice.lastIndexOf("1");
  if (separatorIndex <= 0) return null;

  const hrp = invoice.slice(0, separatorIndex).toLowerCase();
  if (!BOLT11_PREFIX_RE.test(hrp)) return null;
  const amountPart = hrp.replace(BOLT11_PREFIX_RE, "");
  if (!amountPart) return null;

  const unitSuffix = amountPart.slice(-1);
  const hasUnit = /[munp]/.test(unitSuffix);
  const digits = hasUnit ? amountPart.slice(0, -1) : amountPart;
  if (!/^\d+$/.test(digits)) return null;

  const value = Number(digits);
  if (!Number.isFinite(value) || value <= 0) return null;

  const msatAmount = (() => {
    if (!hasUnit) return value * 100_000_000_000;
    if (unitSuffix === "m") return value * 100_000_000;
    if (unitSuffix === "u") return value * 100_000;
    if (unitSuffix === "n") return value * 100;
    if (unitSuffix === "p") return value / 10;
    return null;
  })();

  if (!Number.isFinite(msatAmount) || msatAmount === null || msatAmount <= 0) {
    return null;
  }

  return Math.ceil(msatAmount);
};

const parseBolt11AmountSat = (invoice: string): number | null => {
  const msat = parseBolt11AmountMsat(invoice);
  if (msat === null) return null;
  return Math.ceil(msat / 1000);
};

const parseWordNumber = (words: readonly number[]): number | null => {
  let value = 0;
  for (const word of words) {
    if (!Number.isInteger(word) || word < 0 || word > 31) return null;
    value = value * 32 + word;
    if (!Number.isSafeInteger(value)) return null;
  }
  return value;
};

const toHex = (bytes: Uint8Array): string => {
  let result = "";
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, "0");
  }
  return result;
};

/** True when the (trimmed, `lightning:`-stripped) text carries a bolt11 HRP. */
export const isBolt11Invoice = (raw: string): boolean =>
  BOLT11_PREFIX_RE.test(raw.trim().replace(/^lightning:/i, "").trim());

interface MutableFields {
  description: string | null;
  descriptionHashHex: string | null;
  paymentHashHex: string | null;
  explicitExpirySec: number | null;
}

const readTaggedFields = (words: readonly number[]): MutableFields => {
  const fields: MutableFields = {
    description: null,
    descriptionHashHex: null,
    paymentHashHex: null,
    explicitExpirySec: null,
  };
  const payloadWords =
    words.length > BOLT11_SIGNATURE_WORDS + BOLT11_TIMESTAMP_WORDS
      ? words.slice(BOLT11_TIMESTAMP_WORDS, -BOLT11_SIGNATURE_WORDS)
      : [];

  let offset = 0;
  while (offset + 3 <= payloadWords.length) {
    const tag = payloadWords[offset];
    const dataLength = parseWordNumber(payloadWords.slice(offset + 1, offset + 3));
    if (dataLength === null) break;

    const start = offset + 3;
    const end = start + dataLength;
    if (end > payloadWords.length) break;
    const data = payloadWords.slice(start, end);

    try {
      if (tag === DESCRIPTION_TAG && fields.description === null) {
        const decoded = utf8.encode(Uint8Array.from(bech32.fromWords(data))).trim();
        if (decoded) fields.description = decoded;
      }
      if (tag === DESCRIPTION_HASH_TAG && fields.descriptionHashHex === null && dataLength === 52) {
        const bytes = bech32.fromWords(data);
        if (bytes.length === 32) fields.descriptionHashHex = toHex(bytes);
      }
      if (tag === PAYMENT_HASH_TAG && fields.paymentHashHex === null && dataLength === 52) {
        const bytes = bech32.fromWords(data);
        if (bytes.length === 32) fields.paymentHashHex = toHex(bytes);
      }
      if (tag === EXPIRY_TAG && fields.explicitExpirySec === null) {
        const parsedExpiry = parseWordNumber(data);
        if (parsedExpiry !== null && parsedExpiry > 0) fields.explicitExpirySec = parsedExpiry;
      }
    } catch {
      // A malformed field never poisons the others (PoC leniency).
    }

    offset = end;
  }

  return fields;
};

/**
 * Parses a BOLT11 invoice (optionally `lightning:`-prefixed). Fails only when
 * the text does not carry a bolt11 HRP at all; payloads that do not bech32-
 * decode still succeed with `null` detail fields (PoC leniency — the HRP
 * amount alone is enough for a preview).
 */
export const parseBolt11Invoice = (
  raw: string,
): Effect.Effect<Bolt11Invoice, InvalidBolt11InvoiceError> =>
  Effect.suspend(() => {
    const invoice = String(raw)
      .trim()
      .replace(/^lightning:/i, "")
      .trim();
    if (invoice === "") {
      return Effect.fail(new InvalidBolt11InvoiceError({ reason: "empty" }));
    }
    const prefixMatch = BOLT11_PREFIX_RE.exec(invoice);
    if (prefixMatch === null) {
      return Effect.fail(new InvalidBolt11InvoiceError({ reason: "not-bolt11" }));
    }

    const amountMsat = parseBolt11AmountMsat(invoice);
    let description: string | null = null;
    let descriptionHashHex: string | null = null;
    let paymentHashHex: string | null = null;
    let timestampSec: number | null = null;
    let expiresAtSec: number | null = null;

    try {
      const decoded = bech32.decodeUnsafe(invoice.toLowerCase(), BOLT11_WORD_LIMIT);
      if (decoded !== undefined && decoded.words.length >= BOLT11_TIMESTAMP_WORDS) {
        const { words } = decoded;
        const parsedTimestamp = parseWordNumber(words.slice(0, BOLT11_TIMESTAMP_WORDS));
        const fields = readTaggedFields(words);
        description = fields.description;
        descriptionHashHex = fields.descriptionHashHex;
        paymentHashHex = fields.paymentHashHex;
        if (parsedTimestamp !== null && parsedTimestamp > 0) {
          timestampSec = parsedTimestamp;
          expiresAtSec = parsedTimestamp + (fields.explicitExpirySec ?? DEFAULT_EXPIRY_SECONDS);
        }
      }
    } catch {
      // Undecodable payload: keep the HRP-derived preview (PoC behavior).
    }

    return Effect.succeed<Bolt11Invoice>({
      invoice,
      network: networkOf(prefixMatch[1] ?? "lnbc"),
      amountMsat,
      amountSat: parseBolt11AmountSat(invoice),
      description,
      descriptionHashHex,
      paymentHashHex,
      timestampSec,
      expiresAtSec,
    });
  });
