/**
 * LNURL-pay metadata + invoice fetch over a stubbed HttpClient. Fixture
 * responses mirror real LNURL-pay services (and the PoC's test data).
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { fetchLnurlPayInvoice, fetchLnurlPayMetadata } from "./lnurlPay.js";
import type { LnurlPayMetadata } from "./lnurlPay.js";
import { buildInvoice, hexWords, lightningHttpStub, ok } from "./__tests__/lightningTestKit.js";

const METADATA_RAW = JSON.stringify([["text/plain", "Pay to alice"]]);
const PAY_ENDPOINT = "https://pay.example.org/.well-known/lnurlp/alice";
const CALLBACK = "https://pay.example.org/lnurlp/cb/alice";

const basePayResponse = {
  tag: "payRequest",
  callback: CALLBACK,
  minSendable: 1000,
  maxSendable: 100_000_000,
  metadata: METADATA_RAW,
  commentAllowed: 20,
};

const sha256Hex = (text: string): string => {
  let hex = "";
  for (const byte of sha256(new TextEncoder().encode(text))) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
};

/** Invoice the callback returns for `amountSat`, with a valid LUD-06 h tag. */
const invoiceFor = (amountSat: number, metadataRaw: string = METADATA_RAW): string =>
  buildInvoice({
    hrp: `lnbc${String(amountSat * 10)}n`, // sat*10 in `n` units = sat*1000 msat
    timestampSec: 1_700_000_000,
    tags: [["h", hexWords(sha256Hex(metadataRaw))]],
  });

const run = <A, E>(
  effect: Effect.Effect<A, E, never>,
): Promise<A> => Effect.runPromise(effect);

describe("fetchLnurlPayMetadata", () => {
  it("loads, validates and rounds a pay request (address target)", async () => {
    const stub = lightningHttpStub([
      [PAY_ENDPOINT, () => ok({ ...basePayResponse, minSendable: 1500, maxSendable: 4999 })],
    ]);
    const metadata = await run(
      fetchLnurlPayMetadata("alice@pay.example.org").pipe(Effect.provide(stub.layer)),
    );
    expect(metadata).toMatchObject({
      requestUrl: PAY_ENDPOINT,
      callback: CALLBACK,
      minSendableMsat: 1500,
      maxSendableMsat: 4999,
      minSendableSat: 2, // ceil
      maxSendableSat: 4, // floor
      commentAllowed: 20,
      description: "Pay to alice",
      metadataRaw: METADATA_RAW,
      target: "pay.example.org/.well-known/lnurlp/alice",
    });
  });

  it("accepts tag-less responses that look like pay requests (PoC tolerance)", async () => {
    const { tag: _tag, ...tagless } = basePayResponse;
    const stub = lightningHttpStub([[PAY_ENDPOINT, () => ok(tagless)]]);
    const metadata = await run(
      fetchLnurlPayMetadata("alice@pay.example.org").pipe(Effect.provide(stub.layer)),
    );
    expect(metadata.callback).toBe(CALLBACK);
  });

  it("fails with LnurlTagMismatchError for a withdrawRequest response", async () => {
    const stub = lightningHttpStub([
      [
        PAY_ENDPOINT,
        () =>
          ok({
            tag: "withdrawRequest",
            callback: CALLBACK,
            k1: "n1",
            minWithdrawable: 1000,
            maxWithdrawable: 1000,
          }),
      ],
    ]);
    const error = await run(
      Effect.flip(fetchLnurlPayMetadata("alice@pay.example.org")).pipe(
        Effect.provide(stub.layer),
      ),
    );
    expect(error).toMatchObject({
      _tag: "LnurlTagMismatchError",
      expected: "payRequest",
      tag: "withdrawRequest",
    });
  });

  it("fails with LnurlStatusError when the service reports ERROR", async () => {
    const stub = lightningHttpStub([
      [PAY_ENDPOINT, () => ok({ status: "ERROR", reason: "user not found" })],
    ]);
    const error = await run(
      Effect.flip(fetchLnurlPayMetadata("alice@pay.example.org")).pipe(
        Effect.provide(stub.layer),
      ),
    );
    expect(error).toMatchObject({ _tag: "LnurlStatusError", reason: "user not found" });
  });

  it("fails with LnurlResponseError on bad ranges, missing metadata, non-2xx", async () => {
    const cases: Array<{ body: unknown; status?: number; reason: RegExp }> = [
      { body: { ...basePayResponse, minSendable: 5000, maxSendable: 1000 }, reason: /minSendable/ },
      { body: { ...basePayResponse, minSendable: 0 }, reason: /minSendable/ },
      { body: { ...basePayResponse, metadata: undefined }, reason: /metadata missing/ },
      {
        body: { ...basePayResponse, metadata: JSON.stringify([["image/png", "x"]]) },
        reason: /text\/plain/,
      },
      { body: { oops: true }, status: 404, reason: /HTTP 404/ },
    ];
    for (const testCase of cases) {
      const stub = lightningHttpStub([
        [PAY_ENDPOINT, () => ({ status: testCase.status ?? 200, body: testCase.body })],
      ]);
      const error = await run(
        Effect.flip(fetchLnurlPayMetadata("alice@pay.example.org")).pipe(
          Effect.provide(stub.layer),
        ),
      );
      expect(error._tag).toBe("LnurlResponseError");
      if (error._tag === "LnurlResponseError") {
        expect(error.reason).toMatch(testCase.reason);
      }
    }
  });

  it("rejects withdraw-only targets without any HTTP call", async () => {
    const stub = lightningHttpStub([]);
    const error = await run(
      Effect.flip(fetchLnurlPayMetadata("lnurlw://withdraw.example/w")).pipe(
        Effect.provide(stub.layer),
      ),
    );
    expect(error).toMatchObject({ _tag: "InvalidLnurlError", reason: "not-pay-target" });
    expect(stub.seenUrls).toEqual([]);
  });
});

const loadedMetadata = (overrides?: Partial<LnurlPayMetadata>): LnurlPayMetadata => ({
  requestUrl: PAY_ENDPOINT,
  callback: CALLBACK,
  minSendableMsat: 1000,
  maxSendableMsat: 100_000_000,
  minSendableSat: 1,
  maxSendableSat: 100_000,
  commentAllowed: 0,
  description: "Pay to alice",
  metadataRaw: METADATA_RAW,
  target: "alice@pay.example.org",
  ...overrides,
});

describe("fetchLnurlPayInvoice", () => {
  it("fetches and verifies an invoice for the requested amount", async () => {
    const stub = lightningHttpStub([
      [
        CALLBACK,
        (url) => {
          expect(url.searchParams.get("amount")).toBe("21000");
          return ok({ pr: invoiceFor(21), successAction: { tag: "message", message: "thanks" } });
        },
      ],
    ]);
    const result = await run(
      fetchLnurlPayInvoice({ metadata: loadedMetadata(), amountSat: 21 }).pipe(
        Effect.provide(stub.layer),
      ),
    );
    expect(result.amountMsat).toBe(21_000);
    expect(result.invoice).toBe(invoiceFor(21));
    expect(result.successAction).toEqual({ _tag: "message", message: "thanks" });
  });

  it("rejects amounts outside the advertised range without an HTTP call", async () => {
    const stub = lightningHttpStub([]);
    for (const amountSat of [0, 100_001]) {
      const error = await run(
        Effect.flip(
          fetchLnurlPayInvoice({ metadata: loadedMetadata(), amountSat }),
        ).pipe(Effect.provide(stub.layer)),
      );
      expect(error._tag).toBe("LnurlPayAmountOutOfRangeError");
    }
    expect(stub.seenUrls).toEqual([]);
  });

  it("rejects an invoice whose amount differs from the request", async () => {
    const stub = lightningHttpStub([[CALLBACK, () => ok({ pr: invoiceFor(22) })]]);
    const error = await run(
      Effect.flip(fetchLnurlPayInvoice({ metadata: loadedMetadata(), amountSat: 21 })).pipe(
        Effect.provide(stub.layer),
      ),
    );
    expect(error).toMatchObject({
      _tag: "LnurlInvoiceMismatchError",
      reason: "amount-mismatch",
      expectedAmountMsat: 21_000,
      invoiceAmountMsat: 22_000,
    });
  });

  it("rejects an invoice whose h tag does not hash the metadata (LUD-06 step 7)", async () => {
    const stub = lightningHttpStub([
      [CALLBACK, () => ok({ pr: invoiceFor(21, '[["text/plain","evil"]]') })],
    ]);
    const error = await run(
      Effect.flip(fetchLnurlPayInvoice({ metadata: loadedMetadata(), amountSat: 21 })).pipe(
        Effect.provide(stub.layer),
      ),
    );
    expect(error).toMatchObject({
      _tag: "LnurlInvoiceMismatchError",
      reason: "metadata-hash-mismatch",
    });
  });

  it("accepts `paymentRequest` as the invoice field name", async () => {
    const stub = lightningHttpStub([
      [CALLBACK, () => ok({ paymentRequest: invoiceFor(21) })],
    ]);
    const result = await run(
      fetchLnurlPayInvoice({ metadata: loadedMetadata(), amountSat: 21 }).pipe(
        Effect.provide(stub.layer),
      ),
    );
    expect(result.invoice).toBe(invoiceFor(21));
  });

  it("sends the comment truncated to an advertised commentAllowed", async () => {
    const stub = lightningHttpStub([
      [
        CALLBACK,
        (url) => {
          expect(url.searchParams.get("comment")).toBe("12345");
          return ok({ pr: invoiceFor(21) });
        },
      ],
    ]);
    await run(
      fetchLnurlPayInvoice({
        metadata: loadedMetadata({ commentAllowed: 5 }),
        amountSat: 21,
        comment: "1234567890",
      }).pipe(Effect.provide(stub.layer)),
    );
    expect(stub.seenUrls).toHaveLength(1);
  });

  it("falls back without the comment when an unadvertised comment fails", async () => {
    let calls = 0;
    const stub = lightningHttpStub([
      [
        CALLBACK,
        (url) => {
          calls += 1;
          if (url.searchParams.has("comment")) {
            return ok({ status: "ERROR", reason: "comment not allowed" });
          }
          return ok({ pr: invoiceFor(21) });
        },
      ],
    ]);
    const result = await run(
      fetchLnurlPayInvoice({
        metadata: loadedMetadata({ commentAllowed: 0 }),
        amountSat: 21,
        comment: "hello from linky",
      }).pipe(Effect.provide(stub.layer)),
    );
    expect(result.invoice).toBe(invoiceFor(21));
    expect(calls).toBe(2);
  });

  it("drops unsafe success actions (non-http url, unknown tags)", async () => {
    for (const successAction of [
      { tag: "url", url: "javascript:alert(1)" },
      { tag: "aes", description: "x", ciphertext: "y", iv: "z" },
    ]) {
      const stub = lightningHttpStub([
        [CALLBACK, () => ok({ pr: invoiceFor(21), successAction })],
      ]);
      const result = await run(
        fetchLnurlPayInvoice({ metadata: loadedMetadata(), amountSat: 21 }).pipe(
          Effect.provide(stub.layer),
        ),
      );
      expect(result.successAction).toBeNull();
    }
  });

  it("surfaces callback ERROR responses as LnurlStatusError", async () => {
    const stub = lightningHttpStub([
      [CALLBACK, () => ok({ status: "ERROR", reason: "route not found" })],
    ]);
    const error = await run(
      Effect.flip(fetchLnurlPayInvoice({ metadata: loadedMetadata(), amountSat: 21 })).pipe(
        Effect.provide(stub.layer),
      ),
    );
    expect(error).toMatchObject({ _tag: "LnurlStatusError", reason: "route not found" });
  });
});
