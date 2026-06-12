/**
 * Golden parity with the PoC's LNURL-pay WIRE behavior
 * (`__fixtures__/lnurlPayCallback.golden.json`, generated from the PoC's own
 * `lnurlPay.ts` with a stubbed fetch — see `generate-callback.poc.ts.txt`):
 * the metadata request URL, the min/max sat preview rounding, and the
 * callback request URLs (amount param, LUD-12 comment handling incl. the
 * silent no-comment retry).
 *
 * Two intentional divergences from the PoC, asserted explicitly below:
 *
 * 1. INVERTED LUD-12 CONDITION (PoC bug, fixed in #34's `lnurlPay.ts`): when
 *    the provider ADVERTISES `commentAllowed`, the PoC built the truncated
 *    comment URL but then fetched the no-comment URL — the comment was only
 *    ever sent to providers that did NOT advertise support. Core sends the
 *    truncated comment exactly when support is advertised.
 * 2. QUERY ENCODING: the PoC encodes via `URLSearchParams` (space → `+`),
 *    core via `encodeURIComponent` (space → `%20`). Both are valid
 *    x-www-form-urlencoded spellings of the same value; the golden
 *    comparison normalizes `+` to `%20`.
 */
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { fetchLnurlPayInvoice, fetchLnurlPayMetadata } from "./lnurlPay.js";
import { lightningHttpStub, ok } from "./__tests__/lightningTestKit.js";
import type { LnurlRoute, StubResponse } from "./__tests__/lightningTestKit.js";

interface RecordedCall {
  readonly url: string;
  readonly status: number;
}

interface Scenario {
  readonly requests: ReadonlyArray<RecordedCall>;
  readonly result: unknown;
  readonly error: string | null;
}

interface GoldenFile {
  readonly payRequest: Record<string, unknown>;
  readonly scenarios: {
    readonly preview: Scenario;
    readonly invoiceNoComment: Scenario;
    readonly invoiceAdvertisedComment: Scenario;
    readonly invoiceFallbackComment: Scenario;
  };
}

const golden = JSON.parse(
  readFileSync(new URL("./__fixtures__/lnurlPayCallback.golden.json", import.meta.url), "utf8"),
) as GoldenFile;

/** `+` and `%20` are the same query-encoded space (divergence 2). */
const normalizeQuerySpaces = (url: string): string => url.replace(/\+/g, "%20");

const goldenUrls = (scenario: Scenario): string[] =>
  scenario.requests.map((request) => normalizeQuerySpaces(request.url));

const invoiceBody = { pr: "fixtureinvoice", routes: [] };

const routesFor = (
  payRequest: Record<string, unknown>,
  callback?: (url: URL) => StubResponse,
): ReadonlyArray<LnurlRoute> => [
  ["https://fixture.test/lnurlp/callback", callback ?? (() => ok(invoiceBody))],
  ["https://fixture.test/.well-known/lnurlp/alice", () => ok(payRequest)],
];

const loadMetadata = (stub: ReturnType<typeof lightningHttpStub>) =>
  Effect.runPromise(
    fetchLnurlPayMetadata("alice@fixture.test").pipe(Effect.provide(stub.layer)),
  );

describe("LNURL-pay callback golden parity (PoC wire shape)", () => {
  it("loads pay metadata from the PoC's well-known URL with the PoC's rounding", async () => {
    const scenario = golden.scenarios.preview;
    const stub = lightningHttpStub(routesFor(golden.payRequest));
    const metadata = await loadMetadata(stub);

    expect(stub.seenUrls.map(normalizeQuerySpaces)).toEqual(goldenUrls(scenario));

    const poc = scenario.result as Record<string, unknown>;
    expect(metadata.callback).toBe(poc["callback"]);
    expect(metadata.minSendableMsat).toBe(poc["minSendableMsat"]);
    expect(metadata.maxSendableMsat).toBe(poc["maxSendableMsat"]);
    // Conservative rounding: ceil(min/1000), floor(max/1000).
    expect(metadata.minSendableSat).toBe(poc["minSendableSat"]);
    expect(metadata.maxSendableSat).toBe(poc["maxSendableSat"]);
    expect(metadata.commentAllowed).toBe(poc["commentAllowed"]);
    expect(metadata.description).toBe(poc["description"]);
    expect(metadata.metadataRaw).toBe(poc["metadataRaw"]);
    expect(metadata.target).toBe(poc["target"]);
  });

  it("requests the invoice with the msat amount appended to the callback query", async () => {
    const scenario = golden.scenarios.invoiceNoComment;
    const stub = lightningHttpStub(routesFor(golden.payRequest));
    const metadata = await loadMetadata(stub);
    const invoice = await Effect.runPromise(
      fetchLnurlPayInvoice({ metadata, amountSat: 21 }).pipe(Effect.provide(stub.layer)),
    );

    expect(stub.seenUrls.map(normalizeQuerySpaces)).toEqual(goldenUrls(scenario));
    expect(invoice.invoice).toBe((scenario.result as { pr: string }).pr);
    expect(invoice.successAction).toBeNull();
  });

  it("DIVERGENCE 1: sends the truncated comment when commentAllowed is advertised", async () => {
    const scenario = golden.scenarios.invoiceAdvertisedComment;
    // The PoC (inverted condition) never sent the advertised comment:
    expect(goldenUrls(scenario).at(-1)).toBe(
      "https://fixture.test/lnurlp/callback?session=abc&amount=21000",
    );

    const payRequest = { ...golden.payRequest, commentAllowed: 12 };
    const stub = lightningHttpStub(routesFor(payRequest));
    const metadata = await loadMetadata(stub);
    await Effect.runPromise(
      fetchLnurlPayInvoice({ metadata, amountSat: 21, comment: "Hello from Linky" }).pipe(
        Effect.provide(stub.layer),
      ),
    );

    // Core fixes the inversion: one call, comment truncated to 12 chars.
    expect(stub.seenUrls.map(normalizeQuerySpaces)).toEqual([
      goldenUrls(scenario)[0],
      "https://fixture.test/lnurlp/callback?session=abc&amount=21000&comment=Hello%20from%20L",
    ]);
  });

  it("retries silently without the comment when an unadvertised comment fails", async () => {
    const scenario = golden.scenarios.invoiceFallbackComment;
    const stub = lightningHttpStub(
      routesFor(golden.payRequest, (url) =>
        url.searchParams.has("comment")
          ? { status: 500, body: { status: "ERROR", reason: "no comments" } }
          : ok(invoiceBody),
      ),
    );
    const metadata = await loadMetadata(stub);
    const invoice = await Effect.runPromise(
      fetchLnurlPayInvoice({ metadata, amountSat: 21, comment: "Hello from Linky" }).pipe(
        Effect.provide(stub.layer),
      ),
    );

    // Same wire sequence as the PoC: with-comment try (500) → bare retry.
    expect(stub.seenUrls.map(normalizeQuerySpaces)).toEqual(goldenUrls(scenario));
    expect(invoice.invoice).toBe((scenario.result as { pr: string }).pr);
  });
});
