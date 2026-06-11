/**
 * AmountDisplayProvider — app-wide amount display state (`wallet.display-unit`).
 *
 * One provider above the navigator so the unit and hidden-mode flags are
 * shared by EVERY amount render site (wallet home today; token lists,
 * transactions and chat payment bubbles later). Screens read it via
 * `useAmountDisplay()` and pass the values into <Amount /> from @linky/ui —
 * that pairing is what enforces the feature-map contract "amount masking
 * must apply consistently everywhere".
 *
 * Follows the LocaleProvider pattern: persisted prefs load through the
 * KeyValueStorage layer without blocking first paint (defaults render
 * immediately), user changes update state synchronously and persist
 * fire-and-forget.
 */
import type { AmountDisplayUnit } from "@linky/ui/amount";
import { nextAmountDisplayUnit } from "@linky/ui/amount";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { runAppEffect, useEffectQuery } from "../runtime";
import {
  DEFAULT_AMOUNT_DISPLAY_PREFS,
  loadAmountDisplayPrefs,
  persistAmountDisplayUnit,
  persistAmountsHidden,
} from "./displayPreferences";

export interface AmountDisplayContextValue {
  readonly unit: AmountDisplayUnit;
  readonly hidden: boolean;
  /** Tap-the-balance action: advance to the next unit in the cycle. */
  readonly cycleUnit: () => void;
  /** Eye-toggle action: flip hidden-amount mode. */
  readonly toggleHidden: () => void;
}

const AmountDisplayContext = createContext<AmountDisplayContextValue | null>(null);

export function AmountDisplayProvider({ children }: { readonly children: ReactNode }) {
  const persisted = useEffectQuery(loadAmountDisplayPrefs);
  const [unitOverride, setUnitOverride] = useState<AmountDisplayUnit | null>(null);
  const [hiddenOverride, setHiddenOverride] = useState<boolean | null>(null);

  const loaded = persisted.status === "success" ? persisted.data : DEFAULT_AMOUNT_DISPLAY_PREFS;
  const unit = unitOverride ?? loaded.unit;
  const hidden = hiddenOverride ?? loaded.hidden;

  const cycleUnit = useCallback(() => {
    const next = nextAmountDisplayUnit(unit);
    setUnitOverride(next);
    // Best-effort persistence (E = never); rejection would be a defect.
    void runAppEffect(persistAmountDisplayUnit(next));
  }, [unit]);

  const toggleHidden = useCallback(() => {
    const next = !hidden;
    setHiddenOverride(next);
    void runAppEffect(persistAmountsHidden(next));
  }, [hidden]);

  const value = useMemo(
    () => ({ unit, hidden, cycleUnit, toggleHidden }),
    [unit, hidden, cycleUnit, toggleHidden],
  );

  return <AmountDisplayContext.Provider value={value}>{children}</AmountDisplayContext.Provider>;
}

/** Current amount-display state; any screen that renders amounts uses this. */
export const useAmountDisplay = (): AmountDisplayContextValue => {
  const value = useContext(AmountDisplayContext);
  if (value === null) {
    throw new Error("useAmountDisplay must be used inside <AmountDisplayProvider>.");
  }
  return value;
};
