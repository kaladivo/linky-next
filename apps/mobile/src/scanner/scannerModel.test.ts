import { describe, expect, it } from "vitest";

import { normalizeCapturedValue, parseScanEntryPoint, scannerTitleKey } from "./scannerModel";

describe("parseScanEntryPoint", () => {
  it("accepts every declared entry point", () => {
    expect(parseScanEntryPoint("scan")).toBe("scan");
    expect(parseScanEntryPoint("contacts")).toBe("contacts");
    expect(parseScanEntryPoint("send")).toBe("send");
    expect(parseScanEntryPoint("receive")).toBe("receive");
  });

  it("falls back to the generic surface for missing/unknown params", () => {
    expect(parseScanEntryPoint(undefined)).toBe("scan");
    expect(parseScanEntryPoint("")).toBe("scan");
    expect(parseScanEntryPoint("wallet")).toBe("scan");
  });

  it("uses the first value of an array param", () => {
    expect(parseScanEntryPoint(["contacts", "send"])).toBe("contacts");
    expect(parseScanEntryPoint([])).toBe("scan");
  });
});

describe("scannerTitleKey", () => {
  it("maps entry points to the PoC titles", () => {
    expect(scannerTitleKey("scan")).toBe("scan");
    expect(scannerTitleKey("contacts")).toBe("contactsScanContactQr");
    expect(scannerTitleKey("send")).toBe("walletSend");
    expect(scannerTitleKey("receive")).toBe("walletReceive");
  });
});

describe("normalizeCapturedValue", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeCapturedValue("  npub1abc\n")).toBe("npub1abc");
  });

  it("rejects empty and whitespace-only input", () => {
    expect(normalizeCapturedValue("")).toBeNull();
    expect(normalizeCapturedValue("   \n\t")).toBeNull();
  });
});
