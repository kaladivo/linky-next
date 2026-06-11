/**
 * @linky/locales — typed translation modules (en, cs), no i18n framework.
 *
 * `en` is the source of truth for the schema; `cs` must define exactly the
 * same keys (compile-time enforced). Locale selection is pure — clients
 * wire persistence and device locales themselves via `resolveLocale`.
 */
export { en } from "./en";
export { cs } from "./cs";
export { createTranslator, interpolate, translate, translations } from "./translate";
export type {
  Messages,
  TemplateParams,
  TranslationKey,
  TranslationParams,
  TranslationValues,
  Translator,
} from "./translate";
export {
  FALLBACK_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  resolveLocale,
} from "./resolve-locale";
export type { SupportedLocale } from "./resolve-locale";
