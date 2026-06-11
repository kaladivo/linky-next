/**
 * Golden parity with the PoC's Lightning/LNURL parsing
 * (`__fixtures__/lightning.golden.json`, generated from the PoC's own code —
 * see the fixture README). Two PoC bugs are fixed on purpose; those vectors
 * are asserted against the documented corrected values instead.
 */
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { parseBolt11AmountMsat, parseBolt11Invoice } from "./bolt11.js";
import { isLightningAddress } from "./lightningAddress.js";
import {
  inferLightningAddressFromLnurl,
  lnurlDisplayText,
  lnurlTargetOrNull,
} from "./lnurl.js";

interface GoldenFile {
  readonly bolt11Previews: Record<
    string,
    {
      readonly invoice: string;
      readonly preview: {
        readonly amountSat: number | null;
        readonly description: string | null;
        readonly expiresAtSec: number | null;
      } | null;
      readonly descriptionHashHex: string | null;
    }
  >;
  readonly bolt11AmountsMsat: Record<
    string,
    { readonly invoice: string; readonly amountMsat: number | null }
  >;
  readonly lnurlTargets: ReadonlyArray<{
    readonly input: string;
    readonly isLightningAddress: boolean;
    readonly resolvedUrl: string | null;
    readonly displayText: string | null;
    readonly inferredAddress: string | null;
  }>;
}

const golden = JSON.parse(
  readFileSync(new URL("./__fixtures__/lightning.golden.json", import.meta.url), "utf8"),
) as GoldenFile;

// Intentional divergences from the PoC (fixture README documents why).
const AMOUNT_DIVERGENCES: Record<string, number> = {
  // PoC regex bug: `lnbc` alternation won for `lnbcrt…` → amount lost.
  regtest500n: 50_000,
};
const RESOLVED_URL_DIVERGENCES: Record<string, string> = {
  // PoC checked "is address" before stripping the lnurlp:// scheme.
  "lnurlp://bob@pay.example.org": "https://pay.example.org/.well-known/lnurlp/bob",
};
const DISPLAY_TEXT_DIVERGENCES: Record<string, string> = {
  // The PoC's display text was pay-only; ours also renders withdraw targets.
  "lnurlw://withdraw.example/api/w?k=1": "withdraw.example/api/w",
};

describe("bolt11 golden parity (PoC lightningInvoice.ts)", () => {
  for (const [name, vector] of Object.entries(golden.bolt11Previews)) {
    it(`matches the PoC preview for ${name}`, async () => {
      const parsed = await Effect.runPromise(
        Effect.either(parseBolt11Invoice(vector.invoice)),
      );

      if (vector.preview === null) {
        // PoC returned no preview (not a bolt11 prefix) ⇔ typed parse error.
        expect(parsed._tag).toBe("Left");
        return;
      }

      expect(parsed._tag).toBe("Right");
      if (parsed._tag !== "Right") return;
      expect(parsed.right.amountSat).toBe(vector.preview.amountSat);
      expect(parsed.right.description).toBe(vector.preview.description);
      expect(parsed.right.expiresAtSec).toBe(vector.preview.expiresAtSec);
      expect(parsed.right.descriptionHashHex).toBe(vector.descriptionHashHex);
    });
  }

  for (const [name, vector] of Object.entries(golden.bolt11AmountsMsat)) {
    it(`matches the PoC msat amount for ${name}`, () => {
      const expected = AMOUNT_DIVERGENCES[name] ?? vector.amountMsat;
      expect(parseBolt11AmountMsat(vector.invoice)).toBe(expected);
    });
  }
});

describe("LNURL target golden parity (PoC lnurlPay.ts)", () => {
  for (const vector of golden.lnurlTargets) {
    it(`matches the PoC resolution for ${JSON.stringify(vector.input)}`, () => {
      expect(isLightningAddress(vector.input)).toBe(vector.isLightningAddress);

      const target = lnurlTargetOrNull(vector.input);
      const expectedUrl = RESOLVED_URL_DIVERGENCES[vector.input] ?? vector.resolvedUrl;
      // The PoC's resolver was pay-only (withdraw-only targets → null);
      // compare against ours when it is a pay-usable target.
      const payUsableUrl =
        target === null || target.kind === "withdraw" ? null : target.url;
      expect(payUsableUrl).toBe(expectedUrl);

      const expectedDisplay = DISPLAY_TEXT_DIVERGENCES[vector.input] ?? vector.displayText;
      expect(lnurlDisplayText(vector.input)).toBe(expectedDisplay);

      expect(inferLightningAddressFromLnurl(vector.input)).toBe(vector.inferredAddress);
    });
  }
});
