/**
 * BOLT11 parsing beyond the golden parity: payment hash (new over the PoC),
 * network classification, timestamps, prefix handling and leniency.
 * Real-world vectors are the BOLT #11 spec examples.
 */
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { isBolt11Invoice, parseBolt11AmountMsat, parseBolt11Invoice } from "./bolt11.js";
import { buildInvoice, expiryWords, hexWords, utf8Words } from "./__tests__/lightningTestKit.js";

const SPEC_PAYMENT_HASH =
  "0001020304050607080900010203040506070809000102030405060708090102";

const SPEC_COFFEE =
  "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh";
const SPEC_TESTNET =
  "lntb20m1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygshp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqfpp3x9et2e20v6pu37c5d9vax37wxq72un989qrsgqdj545axuxtnfemtpwkc45hx9d2ft7x04mt8q7y6t0k2dge9e7h8kpy9p34ytyslj3yu569aalz2xdk8xkd7ltxqld94u8h2esmsmacgpghe9k8";

const parse = (invoice: string) => Effect.runPromise(parseBolt11Invoice(invoice));
const parseError = (invoice: string) =>
  Effect.runPromise(Effect.flip(parseBolt11Invoice(invoice)));

describe("parseBolt11Invoice", () => {
  it("extracts the payment hash from the spec coffee invoice", async () => {
    const parsed = await parse(SPEC_COFFEE);
    expect(parsed.paymentHashHex).toBe(SPEC_PAYMENT_HASH);
    expect(parsed.network).toBe("mainnet");
    expect(parsed.timestampSec).toBe(1496314658);
    expect(parsed.amountMsat).toBe(250_000_000);
    expect(parsed.amountSat).toBe(250_000);
    expect(parsed.description).toBe("1 cup coffee");
    expect(parsed.expiresAtSec).toBe(1496314658 + 60);
  });

  it("classifies testnet invoices and reads their payment hash", async () => {
    const parsed = await parse(SPEC_TESTNET);
    expect(parsed.network).toBe("testnet");
    expect(parsed.paymentHashHex).toBe(SPEC_PAYMENT_HASH);
    expect(parsed.descriptionHashHex).toBe(
      "3925b6f67e2c340036ed12093dd44e0368df1b6ea26c53dbe4811f58fd5db8c1",
    );
    expect(parsed.description).toBeNull();
  });

  it("classifies regtest invoices and parses their amount (PoC bug fixed)", async () => {
    const invoice = buildInvoice({
      hrp: "lnbcrt500n",
      timestampSec: 1_700_000_000,
      tags: [["d", utf8Words("regtest memo")]],
    });
    const parsed = await parse(invoice);
    expect(parsed.network).toBe("regtest");
    expect(parsed.amountMsat).toBe(50_000);
    expect(parsed.amountSat).toBe(50);
    expect(parsed.description).toBe("regtest memo");
  });

  it("supports amountless invoices with explicit expiry and payment hash", async () => {
    const hash = "ab".repeat(32);
    const invoice = buildInvoice({
      hrp: "lnbc",
      timestampSec: 1_700_000_000,
      tags: [
        ["p", hexWords(hash)],
        ["d", utf8Words("amountless")],
        ["x", expiryWords(7200)],
      ],
    });
    const parsed = await parse(invoice);
    expect(parsed.amountMsat).toBeNull();
    expect(parsed.amountSat).toBeNull();
    expect(parsed.paymentHashHex).toBe(hash);
    expect(parsed.description).toBe("amountless");
    expect(parsed.expiresAtSec).toBe(1_700_000_000 + 7200);
  });

  it("tolerates a lightning: prefix and surrounding whitespace", async () => {
    const parsed = await parse(`  lightning:${SPEC_COFFEE}  `);
    expect(parsed.invoice).toBe(SPEC_COFFEE);
    expect(parsed.amountSat).toBe(250_000);
  });

  it("keeps the HRP amount when the payload is not decodable (PoC leniency)", async () => {
    const parsed = await parse("lnbc21u1notvalidbech32payload");
    expect(parsed.amountSat).toBe(2100);
    expect(parsed.description).toBeNull();
    expect(parsed.paymentHashHex).toBeNull();
    expect(parsed.timestampSec).toBeNull();
    expect(parsed.expiresAtSec).toBeNull();
  });

  it("fails with a typed error for empty and non-bolt11 inputs", async () => {
    expect((await parseError(""))).toMatchObject({
      _tag: "InvalidBolt11InvoiceError",
      reason: "empty",
    });
    expect(await parseError("cashuAeyJ0b2tlbiI6W119")).toMatchObject({
      _tag: "InvalidBolt11InvoiceError",
      reason: "not-bolt11",
    });
    expect(await parseError("lnurl1dp68gurn8ghj7um9wfmxjcm99e5k7tmkxyhkcmn4wfkz7urp0y")).toMatchObject({
      _tag: "InvalidBolt11InvoiceError",
      reason: "not-bolt11",
    });
  });

  it("ignores oversized description-hash and payment-hash fields", async () => {
    // 20 words ≠ 52 → field skipped, not misread.
    const invoice = buildInvoice({
      hrp: "lnbc1u",
      timestampSec: 1_700_000_000,
      tags: [["p", utf8Words("short")], ["h", utf8Words("short")]],
    });
    const parsed = await parse(invoice);
    expect(parsed.paymentHashHex).toBeNull();
    expect(parsed.descriptionHashHex).toBeNull();
  });
});

describe("parseBolt11AmountMsat units", () => {
  it.each([
    ["lnbc21", 2_100_000_000_000], // whole bitcoin, no multiplier
    ["lnbc20m", 2_000_000_000],
    ["lnbc2500u", 250_000_000],
    ["lnbc10n", 1_000],
    ["lnbc2500p", 250],
    ["lnbc9p", 1], // fractional msat rounds up (PoC ceil)
    ["lnbcrt500n", 50_000],
    ["lntb1m", 100_000_000],
  ])("%s → %d msat", (hrp, expected) => {
    expect(parseBolt11AmountMsat(`${hrp}1qqq`)).toBe(expected);
  });

  it.each([["lnbc"], ["lnbc0m"], ["lnbcm"], ["lnbc12x"], ["lnurl"]])(
    "%s has no parseable amount",
    (hrp) => {
      expect(parseBolt11AmountMsat(`${hrp}1qqq`)).toBeNull();
    },
  );
});

describe("isBolt11Invoice", () => {
  it("matches prefixes case-insensitively and through lightning:", () => {
    expect(isBolt11Invoice(SPEC_COFFEE)).toBe(true);
    expect(isBolt11Invoice(SPEC_COFFEE.toUpperCase())).toBe(true);
    expect(isBolt11Invoice(`lightning:${SPEC_COFFEE}`)).toBe(true);
    expect(isBolt11Invoice("lnurl1abc")).toBe(false);
    expect(isBolt11Invoice("user@host.com")).toBe(false);
  });
});
