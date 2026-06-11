/**
 * Unified Lightning input classification (the #48 parser's Lightning slice).
 */
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { parseLightningInput } from "./parseLightningInput.js";
import { encodeLnurl } from "./__tests__/lightningTestKit.js";

const SPEC_COFFEE =
  "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh";

const classify = (input: string) => Effect.runPromise(parseLightningInput(input));

describe("parseLightningInput", () => {
  it("classifies lightning addresses", async () => {
    const result = await classify("satoshi@pay.example.org");
    expect(result._tag).toBe("LightningAddressInput");
    if (result._tag !== "LightningAddressInput") return;
    expect(result.address.user).toBe("satoshi");
    expect(result.address.domain).toBe("pay.example.org");
    expect(result.address.lnurlpUrl).toBe(
      "https://pay.example.org/.well-known/lnurlp/satoshi",
    );
  });

  it("classifies bolt11 invoices (with lightning: prefix)", async () => {
    const result = await classify(`lightning:${SPEC_COFFEE}`);
    expect(result._tag).toBe("Bolt11Input");
    if (result._tag !== "Bolt11Input") return;
    expect(result.invoice.amountSat).toBe(250_000);
    expect(result.invoice.description).toBe("1 cup coffee");
  });

  it("classifies lnurlp:// as a pay target, resolving embedded addresses", async () => {
    const scheme = await classify("lnurlp://pay.example.org/lnurlp/alice");
    expect(scheme).toEqual({
      _tag: "LnurlPayInput",
      url: "https://pay.example.org/lnurlp/alice",
    });
    const address = await classify("lnurlp://bob@pay.example.org");
    expect(address).toEqual({
      _tag: "LnurlPayInput",
      url: "https://pay.example.org/.well-known/lnurlp/bob",
    });
  });

  it("classifies lnurlw:// as a withdraw target", async () => {
    const result = await classify("lnurlw://withdraw.example/api/w?k=1");
    expect(result).toEqual({
      _tag: "LnurlWithdrawInput",
      url: "https://withdraw.example/api/w?k=1",
    });
  });

  it("keeps bech32 LNURLs and bare http URLs kind-unknown until metadata", async () => {
    const lnurl = encodeLnurl("https://service.example/api?q=1").toUpperCase();
    expect(await classify(lnurl)).toEqual({
      _tag: "LnurlInput",
      url: "https://service.example/api?q=1",
    });
    expect(await classify("https://pay.example.org/.well-known/lnurlp/carol")).toEqual({
      _tag: "LnurlInput",
      url: "https://pay.example.org/.well-known/lnurlp/carol",
    });
  });

  it("rejects everything else with a typed error", async () => {
    for (const input of ["", "   ", "cashuAeyJ0b2tlbiI6W119", "npub1xyz", "hello world"]) {
      const error = await Effect.runPromise(Effect.flip(parseLightningInput(input)));
      expect(error._tag).toBe("UnrecognizedLightningInputError");
    }
  });
});
