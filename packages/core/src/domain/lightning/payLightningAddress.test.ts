/**
 * Pay-address workflow: LNURL-pay resolution + invoice verification + melt,
 * end-to-end against the fake mint (no network).
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { ALICE_SEED, makeFundingToken } from "../cashu/__tests__/helpers.js";
import { FAKE_MINT_URL, FakeMint } from "../cashu/__tests__/fakeMint.js";
import { payLightningAddress } from "./payLightningAddress.js";
import {
  buildInvoice,
  hexWords,
  lightningHttpStub,
  ok,
} from "./__tests__/lightningTestKit.js";

const METADATA_RAW = JSON.stringify([["text/plain", "Pay to alice"]]);
const PAY_ENDPOINT = "https://pay.example.org/.well-known/lnurlp/alice";
const CALLBACK = "https://pay.example.org/lnurlp/cb/alice";

const sha256Hex = (text: string): string => {
  let hex = "";
  for (const byte of sha256(new TextEncoder().encode(text))) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
};

const invoiceFor = (amountSat: number): string =>
  buildInvoice({
    hrp: `lnbc${String(amountSat * 10)}n`,
    timestampSec: 1_700_000_000,
    tags: [["h", hexWords(sha256Hex(METADATA_RAW))]],
  });

const metadataRoute = (commentAllowed = 0) =>
  [
    PAY_ENDPOINT,
    () =>
      ok({
        tag: "payRequest",
        callback: CALLBACK,
        minSendable: 1000,
        maxSendable: 100_000_000,
        metadata: METADATA_RAW,
        commentAllowed,
      }),
  ] as const;

describe("payLightningAddress", () => {
  it("resolves the address, fetches the invoice and melts, keeping change", async () => {
    const mint = new FakeMint();
    mint.bolt11FeeReserve = 2;
    const stub = lightningHttpStub(
      [
        metadataRoute(),
        [
          CALLBACK,
          (url) => ok({
            pr: invoiceFor(Number(url.searchParams.get("amount")) / 1000),
            successAction: { tag: "message", message: "Paid!" },
          }),
        ],
      ],
      mint,
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { token } = yield* makeFundingToken(mint, [32, 4], "lnaddr-funding");
        return yield* payLightningAddress({
          seed: ALICE_SEED,
          mintUrl: FAKE_MINT_URL,
          tokens: [token],
          target: "alice@pay.example.org",
          amountSat: 32,
        });
      }).pipe(Effect.provide(stub.layer)),
    );

    expect(result.metadata.target).toBe("pay.example.org/.well-known/lnurlp/alice");
    expect(result.invoice).toBe(invoiceFor(32));
    expect(result.successAction).toEqual({ _tag: "message", message: "Paid!" });
    expect(result.payment.mintUrl).toBe(FAKE_MINT_URL);
    expect(result.payment.paidAmount).toBe(32);
    expect(result.payment.feeReserve).toBe(2);
    // 36 in − 32 paid − 0 LN fee = 4 preserved as NUT-08 change.
    expect(result.payment.changeAmount).toBe(4);
    expect(Option.isSome(result.payment.changeToken)).toBe(true);
    // LNURL endpoints were hit before the mint.
    expect(stub.seenUrls[0]).toBe(PAY_ENDPOINT);
    expect(stub.seenUrls[1]).toContain(CALLBACK);
  });

  it("rejects out-of-range amounts before fetching any invoice", async () => {
    const mint = new FakeMint();
    const stub = lightningHttpStub([metadataRoute()], mint);

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const { token } = yield* makeFundingToken(mint, [32], "lnaddr-range");
        return yield* Effect.flip(
          payLightningAddress({
            seed: ALICE_SEED,
            mintUrl: FAKE_MINT_URL,
            tokens: [token],
            target: "alice@pay.example.org",
            amountSat: 1_000_000, // maxSendable is 100_000 sat
          }),
        );
      }).pipe(Effect.provide(stub.layer)),
    );

    expect(error._tag).toBe("LnurlPayAmountOutOfRangeError");
    expect(stub.seenUrls).toEqual([PAY_ENDPOINT]);
  });

  it("refuses to pay when the callback invoice amount mismatches", async () => {
    const mint = new FakeMint();
    const stub = lightningHttpStub(
      [metadataRoute(), [CALLBACK, () => ok({ pr: invoiceFor(31) })]],
      mint,
    );

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const { token } = yield* makeFundingToken(mint, [32, 4], "lnaddr-mismatch");
        return yield* Effect.flip(
          payLightningAddress({
            seed: ALICE_SEED,
            mintUrl: FAKE_MINT_URL,
            tokens: [token],
            target: "alice@pay.example.org",
            amountSat: 32,
          }),
        );
      }).pipe(Effect.provide(stub.layer)),
    );

    expect(error).toMatchObject({ _tag: "LnurlInvoiceMismatchError", reason: "amount-mismatch" });
    // The mint never saw a melt attempt.
    expect(mint.requestPaths.some((path) => path.includes("/v1/melt"))).toBe(false);
  });

  it("propagates melt failures (insufficient funds incl. fee reserve)", async () => {
    const mint = new FakeMint();
    mint.bolt11FeeReserve = 2;
    const stub = lightningHttpStub(
      [
        metadataRoute(),
        [CALLBACK, (url) => ok({ pr: invoiceFor(Number(url.searchParams.get("amount")) / 1000) })],
      ],
      mint,
    );

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const { token } = yield* makeFundingToken(mint, [32], "lnaddr-poor");
        return yield* Effect.flip(
          payLightningAddress({
            seed: ALICE_SEED,
            mintUrl: FAKE_MINT_URL,
            tokens: [token],
            target: "alice@pay.example.org",
            amountSat: 32,
          }),
        );
      }).pipe(Effect.provide(stub.layer)),
    );

    expect(error).toMatchObject({ _tag: "InsufficientFundsError", required: 34, available: 32 });
  });

  it("surfaces LNURL service errors from the metadata endpoint", async () => {
    const stub = lightningHttpStub([
      [PAY_ENDPOINT, () => ok({ status: "ERROR", reason: "user unknown" })],
    ]);
    const error = await Effect.runPromise(
      Effect.flip(
        payLightningAddress({
          seed: ALICE_SEED,
          mintUrl: FAKE_MINT_URL,
          tokens: [],
          target: "alice@pay.example.org",
          amountSat: 21,
        }),
      ).pipe(Effect.provide(stub.layer)),
    );
    expect(error).toMatchObject({ _tag: "LnurlStatusError", reason: "user unknown" });
  });
});
