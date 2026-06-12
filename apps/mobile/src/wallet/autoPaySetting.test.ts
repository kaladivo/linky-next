/**
 * Auto-pay setting persistence against the in-memory KeyValueStore layer
 * (the displayPreferences test pattern) + the PoC parse rule.
 */
import { decideAutoPay } from "@linky/core";
import { KeyValueStorage } from "@linky/core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_AUTO_PAY_LIMIT_SAT,
  loadAutoPaySetting,
  parseAutoPayLimitSat,
  persistAutoPayLimitSat,
} from "./autoPaySetting";

const run = <A>(effect: Effect.Effect<A, never, KeyValueStorage.KeyValueStore>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(KeyValueStorage.layerMemory)));

describe("auto-pay setting", () => {
  it("defaults to enabled with the PoC 10 000 sat limit", async () => {
    await expect(run(loadAutoPaySetting)).resolves.toEqual({
      enabled: true,
      limitSat: DEFAULT_AUTO_PAY_LIMIT_SAT,
    });
  });

  it("round-trips a persisted limit (incl. 0 = always confirm)", async () => {
    const setting = await run(
      persistAutoPayLimitSat(0).pipe(Effect.andThen(loadAutoPaySetting)),
    );
    expect(setting).toEqual({ enabled: true, limitSat: 0 });
  });

  it("parses like the PoC: junk and negatives fall back to the default", () => {
    expect(parseAutoPayLimitSat("1000")).toBe(1000);
    expect(parseAutoPayLimitSat("0")).toBe(0);
    expect(parseAutoPayLimitSat("-5")).toBe(DEFAULT_AUTO_PAY_LIMIT_SAT);
    expect(parseAutoPayLimitSat("abc")).toBe(DEFAULT_AUTO_PAY_LIMIT_SAT);
    expect(parseAutoPayLimitSat(null)).toBe(DEFAULT_AUTO_PAY_LIMIT_SAT);
  });

  it("feeds decideAutoPay with PoC outcomes (boundary inclusive, amountless confirms)", async () => {
    const setting = await run(loadAutoPaySetting);
    expect(decideAutoPay({ amountSat: 10_000 }, setting)).toBe("auto-pay");
    expect(decideAutoPay({ amountSat: 10_001 }, setting)).toBe("needs-confirmation");
    expect(decideAutoPay({ amountSat: null }, setting)).toBe("needs-confirmation");

    const zero = await run(
      persistAutoPayLimitSat(0).pipe(Effect.andThen(loadAutoPaySetting)),
    );
    expect(decideAutoPay({ amountSat: 1 }, zero)).toBe("needs-confirmation");
  });
});
