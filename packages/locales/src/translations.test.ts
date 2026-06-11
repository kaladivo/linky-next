import { describe, expect, it } from "vitest";

import { cs } from "./cs.js";
import { en } from "./en.js";
import type { TemplateParams, TranslationKey } from "./translate.js";
import { createTranslator, interpolate, translate } from "./translate.js";

// --- Type-level checks (fail `tsc --noEmit`, not the vitest run) ---------

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// cs must define exactly the keys en defines.
type _CsKeysMatchEn = Expect<Equal<keyof typeof cs, TranslationKey>>;

// Every cs template must use exactly the placeholders its en counterpart uses.
type KeysWithMismatchedParams = {
  [K in TranslationKey]: Equal<
    TemplateParams<(typeof en)[K]>,
    TemplateParams<(typeof cs)[K]>
  > extends true
    ? never
    : K;
}[TranslationKey];
type _PlaceholdersMatch = Expect<Equal<KeysWithMismatchedParams, never>>;

// Misuse must not compile.
// @ts-expect-error — unknown key is a compile-time error
translate("en", "noSuchKey");
// @ts-expect-error — parameterized key requires its values
translate("en", "paidSent");
// @ts-expect-error — missing placeholder value is a compile-time error
translate("en", "paidSent", { amount: 21 });
// @ts-expect-error — plain key takes no values argument
translate("en", "appTitle", { amount: 21 });

// --- Runtime checks -------------------------------------------------------

const extractPlaceholders = (template: string): string[] =>
  [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "").sort();

describe("translation catalogs", () => {
  it("cs has exactly the keys en has", () => {
    expect(Object.keys(cs).sort()).toEqual(Object.keys(en).sort());
  });

  it("every message is a non-empty string", () => {
    for (const catalog of [en, cs]) {
      for (const [key, value] of Object.entries(catalog)) {
        expect(typeof value, key).toBe("string");
        expect(value.length, key).toBeGreaterThan(0);
      }
    }
  });

  it("cs templates use the same placeholders as en", () => {
    for (const key of Object.keys(en) as TranslationKey[]) {
      expect(extractPlaceholders(cs[key]), key).toEqual(extractPlaceholders(en[key]));
    }
  });
});

describe("interpolation", () => {
  it("renders parameterized strings in both locales", () => {
    expect(translate("en", "paidSentTo", { amount: 21, unit: "sat", name: "Alice" })).toBe(
      "Sent 21 sat to Alice.",
    );
    expect(translate("cs", "paidSentTo", { amount: 21, unit: "sat", name: "Alice" })).toBe(
      "Odesláno 21 sat → Alice.",
    );
  });

  it("renders repeated and adjacent placeholders", () => {
    expect(translate("en", "onboardingReturnWordCount", { count: 7, total: 20 })).toBe(
      "7/20 words",
    );
  });

  it("returns plain keys verbatim", () => {
    expect(translate("en", "wallet")).toBe("Wallet");
    expect(translate("cs", "wallet")).toBe("Peněženka");
  });

  it("leaves unmatched placeholders intact", () => {
    expect(interpolate("Hello {name}, {missing}!", { name: "Bob" })).toBe("Hello Bob, {missing}!");
  });

  it("createTranslator binds a locale", () => {
    const t = createTranslator("cs");
    expect(t("cancel")).toBe("Zrušit");
    expect(t("topupOverlay", { amount: 100, unit: "sat" })).toBe("Dobito 100 sat.");
  });
});
