import { describe, expect, it } from "vitest";

import { CORE_PACKAGE_NAME, formatSats } from "./index.js";

describe("@linky/core scaffold", () => {
  it("exposes the package name", () => {
    expect(CORE_PACKAGE_NAME).toBe("@linky/core");
  });

  it("formats sats with thousands separators", () => {
    expect(formatSats(0)).toBe("0 sats");
    expect(formatSats(21_000)).toBe("21 000 sats");
  });

  it("rejects invalid amounts", () => {
    expect(() => formatSats(-1)).toThrow(RangeError);
    expect(() => formatSats(0.5)).toThrow(RangeError);
  });
});
