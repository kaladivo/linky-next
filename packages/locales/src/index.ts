/**
 * @linky/locales — typed translation modules (en, cs), no i18n framework.
 *
 * `en` is the source of truth for the schema; `cs` must define exactly the
 * same keys (compile-time enforced). Locale selection is pure — clients
 * wire persistence and device locales themselves via `resolveLocale`.
 */
export { en } from "./en.js";
export { cs } from "./cs.js";
export { createTranslator, interpolate, translate, translations } from "./translate.js";
export type {
  Messages,
  TemplateParams,
  TranslationKey,
  TranslationParams,
  TranslationValues,
  Translator,
} from "./translate.js";
export {
  FALLBACK_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  resolveLocale,
} from "./resolve-locale.js";
export type { SupportedLocale } from "./resolve-locale.js";
