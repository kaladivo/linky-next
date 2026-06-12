/**
 * NFC tag payload builders (#50) — incl. the contract that matters most:
 * everything Linky writes to a tag ROUND-TRIPS through the #48 unified
 * parser (`classifyScanValue`) and the #49 link-arrival path
 * (`decideIncomingUrl`), so a tag tap behaves exactly like a scan.
 */
import { encodeCashuToken, publicKeyHexToNpub } from "@linky/core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideIncomingUrl } from "../scanner/deepLinkRouting";
import { classifyScanValue, decideScanRoute } from "../scanner/scanRouting";
import { buildProfileTagUrl, buildTokenTagUrl } from "./nfcPayload";

const NPUB = publicKeyHexToNpub("11".repeat(32));
if (NPUB === null) throw new Error("test npub failed to encode");

/** A syntactically valid V4 token (decodable; no live mint involved). */
const TOKEN = Effect.runSync(
  encodeCashuToken({
    mintUrl: "https://testnut.cashu.space",
    unit: "sat",
    proofs: [
      { id: "009a1f293253e41e", amount: 8, secret: "nfc-payload-test", C: `02${"11".repeat(32)}` },
    ],
  }),
);

describe("buildProfileTagUrl", () => {
  it("builds the PoC-parity nostr:// URI from any accepted npub form", () => {
    expect(buildProfileTagUrl(NPUB)).toBe(`nostr://${NPUB}`);
    expect(buildProfileTagUrl(NPUB.toUpperCase())).toBe(`nostr://${NPUB}`);
    expect(buildProfileTagUrl(`nostr:${NPUB}`)).toBe(`nostr://${NPUB}`);
  });

  it("rejects invalid npubs instead of writing garbage to a tag", () => {
    expect(buildProfileTagUrl("")).toBeNull();
    expect(buildProfileTagUrl("npub1notvalid")).toBeNull();
    const corrupted = `${NPUB.slice(0, -1)}${NPUB.endsWith("a") ? "c" : "a"}`;
    expect(buildProfileTagUrl(corrupted)).toBeNull();
  });

  it("round-trips through the #48 parser into the contact flow", () => {
    const url = buildProfileTagUrl(NPUB);
    expect(url).not.toBeNull();
    const target = classifyScanValue(url!);
    expect(target).toEqual({ kind: "npub", npub: NPUB });
    expect(decideScanRoute(target, "scan")).toEqual({ kind: "contact-flow", npub: NPUB });
    // OS-level tap (tag → deep link, no app open needed): #49 feeds the
    // same value into the same parser.
    expect(decideIncomingUrl(url!)).toEqual({ kind: "scan", value: url });
  });
});

describe("buildTokenTagUrl", () => {
  it("builds the linky.fit share URL with the token in the FRAGMENT", () => {
    const url = buildTokenTagUrl(TOKEN);
    expect(url).not.toBeNull();
    const [base, fragment] = url!.split("#");
    expect(base).toBe("https://linky.fit/cashu/");
    expect(decodeURIComponent(fragment!)).toBe(TOKEN);
  });

  it("rejects undecodable token text instead of writing garbage to a tag", () => {
    expect(buildTokenTagUrl("")).toBeNull();
    expect(buildTokenTagUrl("cashuBnotatoken")).toBeNull();
    expect(buildTokenTagUrl("hello")).toBeNull();
  });

  it("round-trips through the #48 parser into the token import", () => {
    const url = buildTokenTagUrl(TOKEN);
    expect(url).not.toBeNull();
    const target = classifyScanValue(url!);
    expect(target).toEqual({ kind: "cashu-token", token: TOKEN });
    expect(decideScanRoute(target, "scan")).toEqual({ kind: "import-token", token: TOKEN });
    // OS-level tap: the universal link goes through #49 into the same parser.
    expect(decideIncomingUrl(url!)).toEqual({ kind: "scan", value: url });
  });
});
