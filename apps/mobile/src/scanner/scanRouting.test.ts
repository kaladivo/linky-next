/**
 * Unified scan parsing + entry-point routing matrix (#48).
 *
 * Classification cases mirror the PoC scanner's accepted forms (the core
 * parsers are themselves pinned by PoC golden fixtures: lightning.golden /
 * cashuWallet.golden); the routing matrix pins the issue's entry-point
 * contract — receive/contacts never initiate a payment.
 */
import { encodeCashuToken, publicKeyHexToNpub } from "@linky/core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { ScanEntryPoint } from "./scanContract";
import { classifyScanValue, decideScanRoute } from "./scanRouting";
import type { ScanTarget } from "./scanRouting";

const NPUB = publicKeyHexToNpub("11".repeat(32));
if (NPUB === null) throw new Error("test npub failed to encode");

/** BOLT11 spec example ("1 cup coffee", 250 000 sat). */
const BOLT11 =
  "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh";

/** A syntactically valid V4 token (decodable; no live mint involved). */
const TOKEN = Effect.runSync(
  encodeCashuToken({
    mintUrl: "https://testnut.cashu.space",
    unit: "sat",
    proofs: [{ id: "009a1f293253e41e", amount: 2, secret: "scan-routing-test", C: `02${"11".repeat(32)}` }],
  }),
);

describe("classifyScanValue", () => {
  it("extracts Cashu tokens from raw text and wrapped links (parse-cashu)", () => {
    expect(classifyScanValue(TOKEN)).toEqual({ kind: "cashu-token", token: TOKEN });
    expect(classifyScanValue(`cashu://${TOKEN}`)).toEqual({ kind: "cashu-token", token: TOKEN });
    expect(classifyScanValue(`https://linky.fit/cashu/#${encodeURIComponent(TOKEN)}`)).toEqual({
      kind: "cashu-token",
      token: TOKEN,
    });
    expect(classifyScanValue(`here is money: ${TOKEN} enjoy`)).toEqual({
      kind: "cashu-token",
      token: TOKEN,
    });
  });

  it("recognizes npubs in every related-link form (parse-nostr)", () => {
    expect(classifyScanValue(NPUB)).toEqual({ kind: "npub", npub: NPUB });
    expect(classifyScanValue(NPUB.toUpperCase())).toEqual({ kind: "npub", npub: NPUB });
    expect(classifyScanValue(`nostr:${NPUB}`)).toEqual({ kind: "npub", npub: NPUB });
    expect(classifyScanValue(`nostr://contact/${NPUB}`)).toEqual({ kind: "npub", npub: NPUB });
    expect(classifyScanValue(`nostr://npub/${NPUB}`)).toEqual({ kind: "npub", npub: NPUB });
    // npub.cash Lightning addresses identify a contact (#27 semantics).
    expect(classifyScanValue(`${NPUB}@npub.cash`)).toEqual({ kind: "npub", npub: NPUB });
  });

  it("rejects checksum-invalid npubs instead of guessing", () => {
    const corrupted = `${NPUB.slice(0, -1)}${NPUB.endsWith("a") ? "c" : "a"}`;
    expect(classifyScanValue(corrupted)).toEqual({ kind: "unsupported" });
  });

  it("classifies the Lightning chain (parse-lightning)", () => {
    expect(classifyScanValue(BOLT11)).toMatchObject({ kind: "bolt11" });
    expect(classifyScanValue(`lightning:${BOLT11}`)).toMatchObject({ kind: "bolt11" });
    expect(classifyScanValue("satoshi@pay.example.org")).toEqual({
      kind: "lightning-address",
      address: "satoshi@pay.example.org",
    });
    expect(classifyScanValue("lnurlp://pay.example.org/lnurlp/alice")).toEqual({
      kind: "lnurl-pay",
      url: "https://pay.example.org/lnurlp/alice",
    });
    expect(classifyScanValue("lnurlw://withdraw.example/api/w?k=1")).toEqual({
      kind: "lnurl-withdraw",
      url: "https://withdraw.example/api/w?k=1",
    });
    // Bare http URLs stay kind-unknown until the metadata probe.
    expect(classifyScanValue("https://service.example/api?q=1")).toEqual({
      kind: "lnurl-unknown",
      url: "https://service.example/api?q=1",
    });
  });

  it("fails visibly on garbage", () => {
    expect(classifyScanValue("")).toEqual({ kind: "unsupported" });
    expect(classifyScanValue("definitely not a scannable value")).toEqual({
      kind: "unsupported",
    });
  });
});

describe("decideScanRoute (route-result matrix)", () => {
  const ENTRIES: ReadonlyArray<ScanEntryPoint> = ["scan", "contacts", "send", "receive"];

  const targets = {
    token: { kind: "cashu-token", token: TOKEN },
    npub: { kind: "npub", npub: NPUB },
    bolt11: { kind: "bolt11", invoice: BOLT11 },
    address: { kind: "lightning-address", address: "satoshi@pay.example.org" },
    lnurlPay: { kind: "lnurl-pay", url: "https://pay.example.org/lnurlp/alice" },
    lnurlWithdraw: { kind: "lnurl-withdraw", url: "https://w.example/api" },
    lnurlUnknown: { kind: "lnurl-unknown", url: "https://u.example/api" },
  } satisfies Record<string, ScanTarget>;

  it("imports tokens and runs the contact flow from EVERY entry (PoC parity)", () => {
    for (const entry of ENTRIES) {
      expect(decideScanRoute(targets.token, entry)).toEqual({
        kind: "import-token",
        token: TOKEN,
      });
      expect(decideScanRoute(targets.npub, entry)).toEqual({ kind: "contact-flow", npub: NPUB });
    }
  });

  it("routes payment targets to the pay flows from scan/send", () => {
    for (const entry of ["scan", "send"] as const) {
      expect(decideScanRoute(targets.bolt11, entry)).toEqual({
        kind: "pay-invoice",
        invoice: BOLT11,
      });
      expect(decideScanRoute(targets.address, entry)).toEqual({
        kind: "pay-target",
        target: "satoshi@pay.example.org",
      });
      expect(decideScanRoute(targets.lnurlPay, entry)).toEqual({
        kind: "pay-target",
        target: "https://pay.example.org/lnurlp/alice",
      });
    }
  });

  it("REJECTS payment targets from receive and contacts (never pay there)", () => {
    for (const entry of ["receive", "contacts"] as const) {
      expect(decideScanRoute(targets.bolt11, entry)).toEqual({ kind: "reject-payment" });
      expect(decideScanRoute(targets.address, entry)).toEqual({ kind: "reject-payment" });
      expect(decideScanRoute(targets.lnurlPay, entry)).toEqual({ kind: "reject-payment" });
    }
  });

  it("allows LNURL-withdraw (incoming money) from every entry", () => {
    for (const entry of ENTRIES) {
      expect(decideScanRoute(targets.lnurlWithdraw, entry)).toEqual({
        kind: "withdraw",
        target: "https://w.example/api",
      });
      // Unknown LNURLs go to the probe; the entry gate re-applies after it.
      expect(decideScanRoute(targets.lnurlUnknown, entry)).toEqual({
        kind: "probe-lnurl",
        url: "https://u.example/api",
      });
    }
  });

  it("keeps garbage unsupported on every entry", () => {
    for (const entry of ENTRIES) {
      expect(decideScanRoute({ kind: "unsupported" }, entry)).toEqual({ kind: "unsupported" });
    }
  });
});
