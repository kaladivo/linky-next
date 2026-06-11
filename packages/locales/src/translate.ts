/**
 * Typed translation access. No i18n framework: keys are plain object keys,
 * `en` is the schema source of truth, and `{param}` placeholders are typed
 * via template-literal types — a missing key or a missing/extra placeholder
 * value is a compile-time error.
 */
import { cs } from "./cs";
import { en } from "./en";
import type { SupportedLocale } from "./resolve-locale";

export const translations = { en, cs } as const;

/** Every translation key. `en` defines the schema. */
export type TranslationKey = keyof typeof en;

/** A full set of messages for one locale. */
export type Messages = Readonly<Record<TranslationKey, string>>;

/** Extracts `{param}` placeholder names from a template literal type. */
export type TemplateParams<S extends string> = S extends `${string}{${infer Param}}${infer Rest}`
  ? Param | TemplateParams<Rest>
  : never;

/** Placeholder names of a key, derived from its `en` template. */
export type TranslationParams<K extends TranslationKey> = TemplateParams<(typeof en)[K]>;

/** Values required to render a key's placeholders. */
export type TranslationValues<K extends TranslationKey> = Readonly<
  Record<TranslationParams<K>, string | number>
>;

/**
 * `[]` for keys without placeholders, a required `[values]` argument for
 * keys with placeholders — so forgetting interpolation values is a
 * compile-time error, as is passing values to a plain key.
 */
type TranslateArgs<K extends TranslationKey> = [TranslationParams<K>] extends [never]
  ? []
  : [values: TranslationValues<K>];

/**
 * Replaces `{name}` placeholders with the given values. Placeholders
 * without a matching value are left intact.
 */
export const interpolate = (
  template: string,
  values: Readonly<Record<string, string | number>>,
): string =>
  template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = values[name];
    return value === undefined ? placeholder : String(value);
  });

/** Translates `key` in `locale`, interpolating placeholder values. */
export const translate = <K extends TranslationKey>(
  locale: SupportedLocale,
  key: K,
  ...args: TranslateArgs<K>
): string => {
  const template: string = translations[locale][key];
  const values = (args as readonly [TranslationValues<K>?])[0];
  return values === undefined ? template : interpolate(template, values);
};

/** A `translate` bound to one locale. */
export type Translator = <K extends TranslationKey>(key: K, ...args: TranslateArgs<K>) => string;

export const createTranslator =
  (locale: SupportedLocale): Translator =>
  (key, ...args) =>
    translate(locale, key, ...args);
