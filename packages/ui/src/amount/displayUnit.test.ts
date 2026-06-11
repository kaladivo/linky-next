import { describe, expect, it } from "vitest";

import {
  AMOUNT_DISPLAY_UNITS,
  DEFAULT_AMOUNT_DISPLAY_UNIT,
  formatAmountParts,
  HIDDEN_AMOUNT_PLACEHOLDER,
  nextAmountDisplayUnit,
  parseAmountDisplayUnit,
} from "./displayUnit";

describe("nextAmountDisplayUnit", () => {
  it("cycles sat → btc → sat", () => {
    expect(nextAmountDisplayUnit("sat")).toBe("btc");
    expect(nextAmountDisplayUnit("btc")).toBe("sat");
  });

  it("visits every unit exactly once per cycle", () => {
    const seen = new Set<string>();
    let unit = DEFAULT_AMOUNT_DISPLAY_UNIT;
    for (let i = 0; i < AMOUNT_DISPLAY_UNITS.length; i += 1) {
      seen.add(unit);
      unit = nextAmountDisplayUnit(unit);
    }
    expect(seen.size).toBe(AMOUNT_DISPLAY_UNITS.length);
    expect(unit).toBe(DEFAULT_AMOUNT_DISPLAY_UNIT);
  });
});

describe("parseAmountDisplayUnit", () => {
  it("parses known units, case/space-insensitively", () => {
    expect(parseAmountDisplayUnit("sat")).toBe("sat");
    expect(parseAmountDisplayUnit(" BTC ")).toBe("btc");
  });

  it("returns null for unknown, empty, and nullish values", () => {
    expect(parseAmountDisplayUnit("czk")).toBeNull(); // fiat: deferred (rate-port TODO)
    expect(parseAmountDisplayUnit("hidden")).toBeNull(); // hidden is not a unit here
    expect(parseAmountDisplayUnit("")).toBeNull();
    expect(parseAmountDisplayUnit(null)).toBeNull();
    expect(parseAmountDisplayUnit(undefined)).toBeNull();
  });
});

describe("formatAmountParts", () => {
  it("formats sats with locale grouping", () => {
    expect(formatAmountParts(75_000, { unit: "sat" })).toEqual({
      text: "75,000",
      unitLabel: "sat",
    });
  });

  it("uses the requested locale's separators", () => {
    const parts = formatAmountParts(75_000, { unit: "sat", locale: "cs" });
    expect(parts.unitLabel).toBe("sat");
    // cs groups thousands with a non-breaking space (U+00A0).
    expect(parts.text.replace(/\u00a0/g, " ")).toBe("75 000");
  });

  it("formats btc as true BTC (sats / 1e8)", () => {
    expect(formatAmountParts(75_000, { unit: "btc" })).toEqual({
      text: "0.00075",
      unitLabel: "₿",
    });
    expect(formatAmountParts(123_456_789, { unit: "btc" })).toEqual({
      text: "1.23456789",
      unitLabel: "₿",
    });
  });

  it("masks everything in hidden mode, for every unit", () => {
    for (const unit of AMOUNT_DISPLAY_UNITS) {
      expect(formatAmountParts(75_000, { unit, hidden: true })).toEqual({
        text: HIDDEN_AMOUNT_PLACEHOLDER,
        unitLabel: "",
      });
    }
  });

  it("clamps negative and non-finite amounts to 0", () => {
    expect(formatAmountParts(-5, { unit: "sat" }).text).toBe("0");
    expect(formatAmountParts(Number.NaN, { unit: "sat" }).text).toBe("0");
    expect(formatAmountParts(Number.POSITIVE_INFINITY, { unit: "btc" }).text).toBe("0");
  });

  it("truncates fractional sat inputs", () => {
    expect(formatAmountParts(12.9, { unit: "sat" }).text).toBe("12");
  });
});
