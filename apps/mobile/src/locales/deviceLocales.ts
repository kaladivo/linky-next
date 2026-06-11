/**
 * Pure mapping from expo-localization's getLocales() shape to the BCP-47
 * tag list `resolveLocale` consumes. Separate module (no expo import) so
 * the mapping is unit-testable in vitest.
 */

/** The subset of expo-localization's Locale this mapping needs. */
export interface DeviceLocaleLike {
  readonly languageTag: string | null;
}

export const languageTagsFromDeviceLocales = (
  locales: readonly DeviceLocaleLike[],
): readonly string[] =>
  locales
    .map((locale) => locale.languageTag)
    .filter((tag): tag is string => typeof tag === "string" && tag.length > 0);
