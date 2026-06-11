import { describe, expect, it } from "vitest";

import { FALLBACK_LOCALE, isSupportedLocale, resolveLocale } from "./resolve-locale.js";

describe("resolveLocale", () => {
  it("prefers a valid persisted preference over device locales", () => {
    expect(resolveLocale("cs", ["en-US"])).toBe("cs");
    expect(resolveLocale("en", ["cs-CZ"])).toBe("en");
  });

  it("ignores an invalid persisted value and falls back to device locales", () => {
    expect(resolveLocale("de", ["cs-CZ"])).toBe("cs");
    expect(resolveLocale("", ["cs-CZ"])).toBe("cs");
    expect(resolveLocale(null, ["cs-CZ"])).toBe("cs");
    expect(resolveLocale(undefined, ["cs-CZ"])).toBe("cs");
  });

  it("matches device locales on the language subtag, case-insensitively", () => {
    expect(resolveLocale(null, ["CS-CZ"])).toBe("cs");
    expect(resolveLocale(null, ["en_US"])).toBe("en");
    expect(resolveLocale(null, [" cs "])).toBe("cs");
  });

  it("uses the first supported device locale", () => {
    expect(resolveLocale(null, ["de-DE", "cs-CZ", "en-US"])).toBe("cs");
    expect(resolveLocale(null, ["de-DE", "en-US", "cs-CZ"])).toBe("en");
  });

  it("falls back to en when nothing matches", () => {
    expect(resolveLocale(null, [])).toBe(FALLBACK_LOCALE);
    expect(resolveLocale(null, ["de-DE", "fr-FR"])).toBe("en");
    expect(resolveLocale(null)).toBe("en");
  });

  it("does not treat a region-tagged persisted value as supported", () => {
    // Persisted values are our own storage format ("en" | "cs"), not BCP-47.
    expect(resolveLocale("cs-CZ", ["de-DE"])).toBe("en");
  });
});

describe("isSupportedLocale", () => {
  it("accepts exactly the supported locales", () => {
    expect(isSupportedLocale("en")).toBe(true);
    expect(isSupportedLocale("cs")).toBe(true);
    expect(isSupportedLocale("de")).toBe(false);
    expect(isSupportedLocale("EN")).toBe(false);
    expect(isSupportedLocale(null)).toBe(false);
    expect(isSupportedLocale(42)).toBe(false);
  });
});
