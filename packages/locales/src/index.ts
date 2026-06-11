/**
 * @linky/locales — typed translation modules (en, cs), no i18n framework.
 *
 * Scaffold stub. Strings are ported from the PoC in a later issue.
 */
export const SUPPORTED_LOCALES = ["en", "cs"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
