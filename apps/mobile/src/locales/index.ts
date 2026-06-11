/**
 * Locale wiring (shell.localization): LocaleProvider + useTranslator()/
 * useLocale() over @linky/locales, persisted via the KeyValueStorage Layer.
 */
export { LocaleProvider, useLocale, useTranslator } from "./LocaleProvider";
export type { LocaleContextValue } from "./LocaleProvider";
