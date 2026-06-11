/**
 * LocaleProvider — wires @linky/locales into the app (shell.localization).
 *
 * Resolution: resolveLocale(persisted preference, device locales). The
 * persisted preference is read through the KeyValueStorage Layer on the
 * app runtime; until that read lands the provider already renders with the
 * device-resolved locale (deferred-startup principle: never block first
 * paint on storage). Today nothing persists a preference yet — onboarding
 * (#17) will call `setLocale`, which updates state immediately and
 * persists fire-and-forget.
 */
import type { SupportedLocale, Translator } from "@linky/locales";
import { createTranslator, resolveLocale } from "@linky/locales";
import { getLocales } from "expo-localization";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { runAppEffect, useEffectQuery } from "../runtime";
import { languageTagsFromDeviceLocales } from "./deviceLocales";
import { loadPersistedLocale, persistLocale } from "./localePreference";

export interface LocaleContextValue {
  readonly locale: SupportedLocale;
  /** Translator bound to `locale`; stable per locale, safe in deps. */
  readonly t: Translator;
  /** Sets + persists an explicit user preference (onboarding/settings, #17). */
  readonly setLocale: (locale: SupportedLocale) => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { readonly children: ReactNode }) {
  // Device locales are fixed for the lifetime of the JS context (iOS/Android
  // restart the app on system-language change).
  const deviceTags = useMemo(() => languageTagsFromDeviceLocales(getLocales()), []);
  const persisted = useEffectQuery(loadPersistedLocale);
  const [override, setOverride] = useState<SupportedLocale | null>(null);

  const locale =
    override ??
    resolveLocale(persisted.status === "success" ? persisted.data : null, deviceTags);

  const t = useMemo(() => createTranslator(locale), [locale]);

  const setLocale = useCallback((next: SupportedLocale) => {
    setOverride(next);
    // Best-effort persistence (E = never); rejection would be a defect.
    void runAppEffect(persistLocale(next));
  }, []);

  const value = useMemo(() => ({ locale, t, setLocale }), [locale, t, setLocale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export const useLocale = (): LocaleContextValue => {
  const value = useContext(LocaleContext);
  if (value === null) {
    throw new Error("useLocale/useTranslator must be used inside <LocaleProvider>.");
  }
  return value;
};

/** The shell's `t()` — every user-visible string goes through this. */
export const useTranslator = (): Translator => useLocale().t;
