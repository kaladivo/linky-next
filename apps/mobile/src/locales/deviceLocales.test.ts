import { resolveLocale } from "@linky/locales";
import { describe, expect, it } from "vitest";

import { languageTagsFromDeviceLocales } from "./deviceLocales";

describe("languageTagsFromDeviceLocales", () => {
  it("extracts tags and drops null/empty entries", () => {
    expect(
      languageTagsFromDeviceLocales([
        { languageTag: "cs-CZ" },
        { languageTag: null },
        { languageTag: "" },
        { languageTag: "en-US" },
      ]),
    ).toEqual(["cs-CZ", "en-US"]);
  });

  it("feeds resolveLocale exactly as the provider does", () => {
    const tags = languageTagsFromDeviceLocales([{ languageTag: "de-DE" }, { languageTag: "cs-CZ" }]);
    // No persisted preference → first supported device locale wins.
    expect(resolveLocale(null, tags)).toBe("cs");
    // Persisted preference wins over device locales.
    expect(resolveLocale("en", tags)).toBe("en");
  });
});
