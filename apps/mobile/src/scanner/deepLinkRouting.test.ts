/**
 * Deep-link → route matrix (#49). The "scan" decisions are additionally
 * pushed through #48's `classifyScanValue` to prove every accepted link
 * form really normalizes into the unified parser (feature-map contract:
 * links feed the SAME parse path as camera/paste/gallery/manual).
 */
import { encodeCashuToken, publicKeyHexToNpub } from "@linky/core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideIncomingUrl, redirectIncomingPath } from "./deepLinkRouting";
import { classifyScanValue } from "./scanRouting";

const NPUB = publicKeyHexToNpub("11".repeat(32));
if (NPUB === null) throw new Error("test npub failed to encode");

/** BOLT11 spec example ("1 cup coffee"). */
const BOLT11 =
  "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh";

/** Valid bech32 LNURL (pinned in core's lightning golden fixtures). */
const LNURL_BECH32 = "lnurl1dp68gurn8ghj7um9wfmxjcm99ejhsctdwpkx2tmpwp5n7ufav93xxvfjxv5ed9lr";

/** A syntactically valid V4 token (decodable; no live mint involved). */
const TOKEN = Effect.runSync(
  encodeCashuToken({
    mintUrl: "https://testnut.cashu.space",
    unit: "sat",
    proofs: [
      { id: "009a1f293253e41e", amount: 2, secret: "deep-link-test", C: `02${"11".repeat(32)}` },
    ],
  }),
);

/** Asserts a URL becomes a scan decision AND the value parses as `kind`. */
const expectScan = (url: string, kind: string) => {
  const decision = decideIncomingUrl(url);
  expect(decision.kind, url).toBe("scan");
  if (decision.kind !== "scan") return;
  expect(classifyScanValue(decision.value), url).toMatchObject({ kind });
};

describe("decideIncomingUrl — value-carrying schemes feed the #48 parser", () => {
  it("accepts every cashu link form (incl. the PoC native deep-link forms)", () => {
    expectScan(`cashu:${TOKEN}`, "cashu-token");
    expectScan(`cashu://${TOKEN}`, "cashu-token");
    expectScan(`web+cashu:${TOKEN}`, "cashu-token");
    // PoC query-key form (`cashu://receive?token=…`).
    expectScan(`cashu://receive?token=${encodeURIComponent(TOKEN)}`, "cashu-token");
  });

  it("accepts every nostr link form (incl. the PoC native deep-link forms)", () => {
    expectScan(`nostr:${NPUB}`, "npub");
    expectScan(`nostr://${NPUB}`, "npub");
    expectScan(`nostr://contact/${NPUB}`, "npub");
    expectScan(`nostr://npub/${NPUB}`, "npub");
    // PoC query-param form (`nostr://open-contact?npub=…`).
    expectScan(`nostr://open-contact?npub=${NPUB}`, "npub");
  });

  it("accepts lightning and lnurl scheme forms", () => {
    expectScan(`lightning:${BOLT11}`, "bolt11");
    expectScan("lightning:satoshi@pay.example.org", "lightning-address");
    expectScan(`lightning:${LNURL_BECH32}`, "lnurl-unknown");
    expectScan("lnurlp://pay.example.org/lnurlp/alice", "lnurl-pay");
    expectScan("lnurlw://withdraw.example/api/w?k=1", "lnurl-withdraw");
    // Bare `lnurl:` wrapper is unwrapped here (core has no such stripper).
    expectScan(`lnurl:${LNURL_BECH32}`, "lnurl-unknown");
    expectScan(`lnurl://${LNURL_BECH32}`, "lnurl-unknown");
  });

  it("malformed scheme payloads still go to /link (visible failure there)", () => {
    // The landing screen surfaces the parser's "unsupported" as toast+tabs.
    expect(decideIncomingUrl("cashu:not-a-token")).toEqual({
      kind: "scan",
      value: "cashu:not-a-token",
    });
    expect(decideIncomingUrl("lnurl:")).toEqual({ kind: "fallback" });
  });
});

describe("decideIncomingUrl — linky.fit universal links", () => {
  it("accepts the canonical fragment share link (token never hits a server)", () => {
    expectScan(`https://linky.fit/cashu/#${encodeURIComponent(TOKEN)}`, "cashu-token");
    expectScan(`https://www.linky.fit/cashu/#${encodeURIComponent(TOKEN)}`, "cashu-token");
    // Legacy/query variants the PoC text extractor accepted stay accepted.
    expectScan(`https://linky.fit/cashu?token=${encodeURIComponent(TOKEN)}`, "cashu-token");
  });

  it("accepts the host-stripped path form some launchers deliver", () => {
    expectScan(`/cashu/#${encodeURIComponent(TOKEN)}`, "cashu-token");
    expect(decideIncomingUrl("/cashu/")).toEqual({ kind: "fallback" });
  });

  it("falls back (toast + tabs) for value-less or unknown linky.fit links", () => {
    expect(decideIncomingUrl("https://linky.fit/cashu/")).toEqual({ kind: "fallback" });
    expect(decideIncomingUrl("https://linky.fit/")).toEqual({ kind: "fallback" });
    expect(decideIncomingUrl("https://linky.fit/some/old/page")).toEqual({ kind: "fallback" });
  });

  it("maps old PoC web-app hash routes to the matching tab (cheap acceptance)", () => {
    expect(decideIncomingUrl("https://app.linky.fit/#wallet/tokens")).toEqual({
      kind: "navigate",
      path: "/(tabs)/wallet",
    });
    expect(decideIncomingUrl("https://app.linky.fit/#wallet")).toEqual({
      kind: "navigate",
      path: "/(tabs)/wallet",
    });
    expect(decideIncomingUrl("https://app.linky.fit/#contacts")).toEqual({
      kind: "navigate",
      path: "/(tabs)",
    });
    expect(decideIncomingUrl("https://app.linky.fit/")).toEqual({
      kind: "navigate",
      path: "/(tabs)",
    });
    // Unknown old routes still land somewhere useful.
    expect(decideIncomingUrl("https://app.linky.fit/#no-such-screen")).toEqual({
      kind: "fallback",
    });
    // A share token on the old app host wins over the hash-route mapping.
    expectScan(`https://app.linky.fit/cashu/#${encodeURIComponent(TOKEN)}`, "cashu-token");
  });
});

describe("decideIncomingUrl — pass-through", () => {
  it("leaves internal navigation and foreign URLs to the router", () => {
    expect(decideIncomingUrl("linky-dev:///dev/restore?phrase=x")).toEqual({ kind: "pass" });
    expect(decideIncomingUrl("/contact/abc")).toEqual({ kind: "pass" });
    expect(decideIncomingUrl("/wallet/send")).toEqual({ kind: "pass" });
    expect(decideIncomingUrl("https://example.org/whatever")).toEqual({ kind: "pass" });
    expect(decideIncomingUrl("")).toEqual({ kind: "pass" });
  });
});

describe("redirectIncomingPath", () => {
  it("rewrites scan decisions to /link with the value URL-encoded", () => {
    expect(redirectIncomingPath(`cashu:${TOKEN}`)).toBe(
      `/link?url=${encodeURIComponent(`cashu:${TOKEN}`)}`,
    );
  });

  it("rewrites fallbacks to the bare /link landing screen", () => {
    expect(redirectIncomingPath("https://linky.fit/old-page")).toBe("/link");
  });

  it("passes internal paths through untouched", () => {
    expect(redirectIncomingPath("/contact/abc")).toBe("/contact/abc");
    expect(redirectIncomingPath("https://app.linky.fit/#wallet")).toBe("/(tabs)/wallet");
  });
});
