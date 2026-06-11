/**
 * LNURL-withdraw: offer preview (PoC test parity) and the withdraw-to-wallet
 * flow — top-up quote minted at the fake mint, invoice handed to the
 * callback, claim left to #32 once the service pays.
 */
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { FAKE_MINT_URL, FakeMint } from "../cashu/__tests__/fakeMint.js";
import { checkTopupQuote, claimTopup } from "../cashu/topup.js";
import { ALICE_SEED } from "../cashu/__tests__/helpers.js";
import { fetchLnurlWithdrawOffer, withdrawViaLnurl } from "./lnurlWithdraw.js";
import type { LnurlWithdrawOffer } from "./lnurlWithdraw.js";
import { encodeLnurl, lightningHttpStub, ok } from "./__tests__/lightningTestKit.js";

const WITHDRAW_ENDPOINT = "https://withdraw.example/lnurl";
const WITHDRAW_CALLBACK = "https://withdraw.example/cb";

const withdrawResponse = {
  tag: "withdrawRequest",
  callback: WITHDRAW_CALLBACK,
  k1: "nonce-1",
  defaultDescription: "Voucher",
  minWithdrawable: 21_000,
  maxWithdrawable: 21_000,
};

describe("fetchLnurlWithdrawOffer", () => {
  it("returns the offer with msat floored to sats (PoC vector)", async () => {
    const stub = lightningHttpStub([[WITHDRAW_ENDPOINT, () => ok(withdrawResponse)]]);
    const offer = await Effect.runPromise(
      fetchLnurlWithdrawOffer("lnurlw://withdraw.example/lnurl").pipe(
        Effect.provide(stub.layer),
      ),
    );
    expect(offer).toMatchObject({
      requestUrl: WITHDRAW_ENDPOINT,
      callback: WITHDRAW_CALLBACK,
      k1: "nonce-1",
      minAmountSat: 21,
      maxAmountSat: 21,
      defaultAmountSat: 21,
      description: "Voucher",
      target: "withdraw.example/lnurl",
    });
  });

  it("accepts a lightning-prefixed bech32 LNURL QR (PoC vector)", async () => {
    const { tag: _tag, ...tagless } = withdrawResponse;
    const stub = lightningHttpStub([[WITHDRAW_ENDPOINT, () => ok(tagless)]]);
    const lnurl = encodeLnurl(WITHDRAW_ENDPOINT).toUpperCase();
    const offer = await Effect.runPromise(
      fetchLnurlWithdrawOffer(`lightning:${lnurl}`).pipe(Effect.provide(stub.layer)),
    );
    expect(offer.defaultAmountSat).toBe(21);
    expect(offer.target).toBe("withdraw.example/lnurl");
  });

  it("fails with a tag mismatch for LNURL-pay metadata (PoC vector)", async () => {
    const stub = lightningHttpStub([
      [
        WITHDRAW_ENDPOINT,
        () =>
          ok({
            tag: "payRequest",
            callback: "https://pay.example/cb",
            minSendable: 1000,
            maxSendable: 1000,
          }),
      ],
    ]);
    const error = await Effect.runPromise(
      Effect.flip(fetchLnurlWithdrawOffer("lnurlw://withdraw.example/lnurl")).pipe(
        Effect.provide(stub.layer),
      ),
    );
    expect(error).toMatchObject({
      _tag: "LnurlTagMismatchError",
      expected: "withdrawRequest",
      tag: "payRequest",
    });
  });

  it("fails with LnurlResponseError for missing k1 or broken ranges", async () => {
    const cases = [
      { ...withdrawResponse, k1: undefined },
      { ...withdrawResponse, minWithdrawable: 900, maxWithdrawable: 900 }, // < 1 sat
      { ...withdrawResponse, minWithdrawable: 42_000, maxWithdrawable: 21_000 },
    ];
    for (const body of cases) {
      const stub = lightningHttpStub([[WITHDRAW_ENDPOINT, () => ok(body)]]);
      const error = await Effect.runPromise(
        Effect.flip(fetchLnurlWithdrawOffer("lnurlw://withdraw.example/lnurl")).pipe(
          Effect.provide(stub.layer),
        ),
      );
      expect(error._tag).toBe("LnurlResponseError");
    }
  });

  it("rejects pay-only targets without any HTTP call", async () => {
    const stub = lightningHttpStub([]);
    const error = await Effect.runPromise(
      Effect.flip(fetchLnurlWithdrawOffer("alice@pay.example.org")).pipe(
        Effect.provide(stub.layer),
      ),
    );
    expect(error).toMatchObject({ _tag: "InvalidLnurlError", reason: "not-withdraw-target" });
    expect(stub.seenUrls).toEqual([]);
  });
});

const offerOf = (overrides?: Partial<LnurlWithdrawOffer>): LnurlWithdrawOffer => ({
  requestUrl: WITHDRAW_ENDPOINT,
  callback: WITHDRAW_CALLBACK,
  k1: "nonce-1",
  minAmountSat: 5,
  maxAmountSat: 21,
  defaultAmountSat: 21,
  description: "Voucher",
  target: "withdraw.example/lnurl",
  ...overrides,
});

describe("withdrawViaLnurl", () => {
  it("mints a top-up quote and submits its invoice to the callback", async () => {
    const mint = new FakeMint();
    const seen: Array<{ k1: string | null; pr: string | null }> = [];
    const stub = lightningHttpStub(
      [
        [
          WITHDRAW_CALLBACK,
          (url) => {
            seen.push({ k1: url.searchParams.get("k1"), pr: url.searchParams.get("pr") });
            return ok({ status: "OK" });
          },
        ],
      ],
      mint,
    );

    const result = await Effect.runPromise(
      withdrawViaLnurl({ mintUrl: FAKE_MINT_URL, offer: offerOf() }).pipe(
        Effect.provide(stub.layer),
      ),
    );

    expect(result.amountSat).toBe(21); // defaults to max withdrawable
    expect(result.quote.mintUrl).toBe(FAKE_MINT_URL);
    expect(result.quote.amount).toBe(21);
    expect(result.quote.state).toBe("UNPAID");
    expect(seen).toEqual([{ k1: "nonce-1", pr: result.quote.invoice }]);
  });

  it("becomes claimable once the service pays — ecash lands via claimTopup", async () => {
    const mint = new FakeMint();
    const stub = lightningHttpStub(
      [[WITHDRAW_CALLBACK, () => ok({ status: "OK" })]],
      mint,
    );

    const claimed = await Effect.runPromise(
      Effect.gen(function* () {
        const { quote } = yield* withdrawViaLnurl({
          mintUrl: FAKE_MINT_URL,
          offer: offerOf(),
          amountSat: 20,
        });
        // The LNURL service pays the invoice asynchronously:
        mint.payQuote(quote.quoteId);
        const status = yield* checkTopupQuote({
          mintUrl: FAKE_MINT_URL,
          quoteId: quote.quoteId,
        });
        expect(status.claimable).toBe(true);
        return yield* claimTopup({
          seed: ALICE_SEED,
          mintUrl: FAKE_MINT_URL,
          quoteId: quote.quoteId,
          amount: quote.amount,
        });
      }).pipe(Effect.provide(stub.layer)),
    );

    expect(claimed.amount).toBe(20);
    expect(claimed.proofs.length).toBeGreaterThan(0);
  });

  it("validates the amount against the offer range before minting a quote", async () => {
    const mint = new FakeMint();
    const stub = lightningHttpStub([], mint);
    for (const amountSat of [4, 22, 10.5]) {
      const error = await Effect.runPromise(
        Effect.flip(
          withdrawViaLnurl({ mintUrl: FAKE_MINT_URL, offer: offerOf(), amountSat }),
        ).pipe(Effect.provide(stub.layer)),
      );
      expect(error._tag).toBe("LnurlWithdrawAmountOutOfRangeError");
    }
    expect(mint.requestPaths).toEqual([]); // no quote was created
  });

  it("surfaces a callback ERROR as LnurlStatusError (quote already minted)", async () => {
    const mint = new FakeMint();
    const stub = lightningHttpStub(
      [[WITHDRAW_CALLBACK, () => ok({ status: "ERROR", reason: "withdraw expired" })]],
      mint,
    );
    const error = await Effect.runPromise(
      Effect.flip(withdrawViaLnurl({ mintUrl: FAKE_MINT_URL, offer: offerOf() })).pipe(
        Effect.provide(stub.layer),
      ),
    );
    expect(error).toMatchObject({ _tag: "LnurlStatusError", reason: "withdraw expired" });
  });
});
