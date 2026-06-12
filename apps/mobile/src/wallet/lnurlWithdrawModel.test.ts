/** LNURL-withdraw presentation logic (#40) — PoC modal/error-copy parity. */
import { describe, expect, it } from "vitest";

import {
  hasVariableWithdrawAmount,
  withdrawConfirmErrorKey,
  withdrawErrorText,
  withdrawOfferErrorKey,
  withdrawOfferSummary,
} from "./lnurlWithdrawModel";

describe("hasVariableWithdrawAmount", () => {
  it("is false for fixed offers (min == max), true for ranges", () => {
    expect(hasVariableWithdrawAmount({ minAmountSat: 21, maxAmountSat: 21 })).toBe(false);
    expect(hasVariableWithdrawAmount({ minAmountSat: 5, maxAmountSat: 21 })).toBe(true);
  });
});

describe("withdrawOfferSummary", () => {
  it("prefers the service description, falls back to the target (PoC)", () => {
    expect(withdrawOfferSummary({ description: "Voucher", target: "w.example/x" })).toBe(
      "Voucher",
    );
    expect(withdrawOfferSummary({ description: null, target: "w.example/x" })).toBe(
      "w.example/x",
    );
  });
});

describe("withdrawOfferErrorKey", () => {
  it("flags unrecognized/pay-only inputs as invalid targets", () => {
    expect(withdrawOfferErrorKey("InvalidLnurlError")).toBe("lnurlWithdrawInvalidTarget");
  });

  it("reads everything else as a load failure", () => {
    for (const tag of [
      "LnurlConnectionError",
      "LnurlResponseError",
      "LnurlStatusError",
      "LnurlTagMismatchError",
      "UNKNOWN",
    ]) {
      expect(withdrawOfferErrorKey(tag)).toBe("lnurlWithdrawLoadFailed");
    }
  });
});

describe("withdrawConfirmErrorKey", () => {
  it("maps mint-side quote failures to the top-up invoice error copy", () => {
    // CashuMintFailure is a union — these are its runtime tags.
    for (const tag of [
      "InvalidAmountError",
      "KeysetUnavailableError",
      "MintConnectionError",
      "MintProtocolError",
      "WalletOperationError",
    ]) {
      expect(withdrawConfirmErrorKey(tag)).toBe("topupInvoiceFailed");
    }
  });

  it("maps LNURL-side failures (and unknowns) to the withdraw error copy", () => {
    for (const tag of [
      "LnurlConnectionError",
      "LnurlResponseError",
      "LnurlStatusError",
      "LnurlWithdrawAmountOutOfRangeError",
      "UNKNOWN",
    ]) {
      expect(withdrawConfirmErrorKey(tag)).toBe("lnurlWithdrawFailed");
    }
  });
});

describe("withdrawErrorText", () => {
  it("appends a service-provided reason, skipping null/blank ones", () => {
    expect(withdrawErrorText("Failed", "withdraw expired")).toBe("Failed: withdraw expired");
    expect(withdrawErrorText("Failed", null)).toBe("Failed");
    expect(withdrawErrorText("Failed", "  ")).toBe("Failed");
  });
});
