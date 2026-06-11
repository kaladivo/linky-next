/**
 * Pay-invoice workflow + the auto-pay-limit contract (#39 feeds the setting).
 */
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { ALICE_SEED, makeFundingToken } from "../cashu/__tests__/helpers.js";
import { FAKE_MINT_URL, FakeMint } from "../cashu/__tests__/fakeMint.js";
import { decideAutoPay, payBolt11Invoice } from "./payBolt11.js";
import { buildInvoice, lightningHttpStub, utf8Words } from "./__tests__/lightningTestKit.js";

describe("decideAutoPay (auto-pay-limit contract)", () => {
  it.each([
    [{ amountSat: 21 }, { enabled: true, limitSat: 100 }, "auto-pay"],
    [{ amountSat: 100 }, { enabled: true, limitSat: 100 }, "auto-pay"], // inclusive
    [{ amountSat: 101 }, { enabled: true, limitSat: 100 }, "needs-confirmation"],
    [{ amountSat: 21 }, { enabled: false, limitSat: 100 }, "needs-confirmation"],
    [{ amountSat: null }, { enabled: true, limitSat: 100 }, "needs-confirmation"], // amountless
    [{ amountSat: 21 }, { enabled: true, limitSat: 0 }, "needs-confirmation"],
    [{ amountSat: 0 }, { enabled: true, limitSat: 0 }, "auto-pay"],
    [{ amountSat: 21 }, { enabled: true, limitSat: Number.NaN }, "needs-confirmation"],
  ] as const)("invoice %o with setting %o → %s", (invoice, setting, expected) => {
    expect(decideAutoPay(invoice, setting)).toBe(expected);
  });
});

describe("payBolt11Invoice", () => {
  const invoice32 = buildInvoice({
    hrp: "lnbc320n",
    timestampSec: 1_700_000_000,
    tags: [["d", utf8Words("test payment")]],
  });

  it("parses, melts from a single mint and preserves the remainder", async () => {
    const mint = new FakeMint();
    mint.bolt11FeeReserve = 2;
    mint.feePaidPerMelt = 1;
    const stub = lightningHttpStub([], mint);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { token } = yield* makeFundingToken(mint, [32, 4], "bolt11-funding");
        return yield* payBolt11Invoice({
          seed: ALICE_SEED,
          mintUrl: FAKE_MINT_URL,
          tokens: [token],
          invoice: `lightning:${invoice32}`,
        });
      }).pipe(Effect.provide(stub.layer)),
    );

    expect(result.invoice.amountSat).toBe(32);
    expect(result.invoice.description).toBe("test payment");
    expect(result.payment.paidAmount).toBe(32);
    expect(result.payment.feePaid).toBe(1);
    // 36 in − 32 paid − 1 LN fee = 3 preserved.
    expect(result.payment.changeAmount).toBe(3);
    expect(Option.isSome(result.payment.changeToken)).toBe(true);
  });

  it("rejects amountless invoices with InvoiceAmountRequiredError", async () => {
    const mint = new FakeMint();
    const stub = lightningHttpStub([], mint);
    const amountless = buildInvoice({ hrp: "lnbc", timestampSec: 1_700_000_000 });

    const error = await Effect.runPromise(
      Effect.flip(
        payBolt11Invoice({
          seed: ALICE_SEED,
          mintUrl: FAKE_MINT_URL,
          tokens: [],
          invoice: amountless,
        }),
      ).pipe(Effect.provide(stub.layer)),
    );

    expect(error._tag).toBe("InvoiceAmountRequiredError");
    expect(stub.seenUrls).toEqual([]); // rejected before any mint traffic
  });

  it("rejects non-bolt11 input with InvalidBolt11InvoiceError", async () => {
    const stub = lightningHttpStub([]);
    const error = await Effect.runPromise(
      Effect.flip(
        payBolt11Invoice({
          seed: ALICE_SEED,
          mintUrl: FAKE_MINT_URL,
          tokens: [],
          invoice: "alice@pay.example.org",
        }),
      ).pipe(Effect.provide(stub.layer)),
    );
    expect(error).toMatchObject({ _tag: "InvalidBolt11InvoiceError", reason: "not-bolt11" });
  });

  it("refuses cross-mint funding tokens (single-mint payments)", async () => {
    const mint = new FakeMint();
    mint.bolt11FeeReserve = 2;
    const stub = lightningHttpStub([], mint);

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const { token } = yield* makeFundingToken(
          mint,
          [32, 4],
          "bolt11-foreign",
          "https://other-mint.test",
        );
        return yield* Effect.flip(
          payBolt11Invoice({
            seed: ALICE_SEED,
            mintUrl: FAKE_MINT_URL,
            tokens: [token],
            invoice: invoice32,
          }),
        );
      }).pipe(Effect.provide(stub.layer)),
    );

    expect(error._tag).toBe("WrongMintError");
  });
});
