/**
 * Locale selection, pure and framework-free.
 *
 * Clients (mobile, future web) feed in their persisted preference and the
 * device/browser locale list; this module only decides which supported
 * locale wins. No React, Expo, or storage imports here.
 */

export const SUPPORTED_LOCALES = ["en", "cs"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** Used when neither the persisted preference nor any device locale matches. */
export const FALLBACK_LOCALE: SupportedLocale = "en";

export const isSupportedLocale = (value: unknown): value is SupportedLocale =>
  typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);

/**
 * Resolves the locale to use.
 *
 * Precedence:
 * 1. `persisted` — an explicit user preference, if it is a supported locale.
 * 2. The first entry in `deviceLocales` whose language subtag is supported.
 *    Entries are BCP-47 tags (e.g. "cs-CZ", "en_US"); only the language
 *    subtag matters and matching is case-insensitive.
 * 3. {@link FALLBACK_LOCALE}.
 */
export const resolveLocale = (
  persisted: string | null | undefined,
  deviceLocales: readonly string[] = [],
): SupportedLocale => {
  if (isSupportedLocale(persisted)) return persisted;

  for (const tag of deviceLocales) {
    const language = tag.trim().toLowerCase().split(/[-_]/, 1)[0];
    if (isSupportedLocale(language)) return language;
  }

  return FALLBACK_LOCALE;
};
