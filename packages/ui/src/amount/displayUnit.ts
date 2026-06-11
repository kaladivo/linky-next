/**
 * Amount display units (`wallet.display-unit` in the feature map) — the pure
 * half of the shared <Amount /> component (issue #36). No React/RN imports:
 * this module is unit-tested with vitest on Node.
 *
 * Cycle set: sat ↔ btc. The PoC additionally cycles czk/usd, but those
 * need a fiat rate service (PoC `useFiatRates` fetches BTC spot rates with a
 * TTL cache). Fiat display is deliberately deferred until a `FiatRates`
 * port exists in @linky/core; when it lands, add the fiat units here and
 * extend `formatAmountParts` with a rates argument — every render site
 * already goes through this module, so nothing else changes.
 * TODO(rate-port): add czk/usd once the FiatRates port exists.
 *
 * Hidden mode is intentionally NOT a unit (unlike the PoC, where "hidden"
 * sits inside the currency cycle): masking is a separate boolean so that
 * tapping through units never accidentally reveals amounts, and the
 * eye-toggle state survives unit changes.
 */

/** Units the amount tap-cycle moves through, in cycle order. */
export const AMOUNT_DISPLAY_UNITS = ["sat", "btc"] as const;

export type AmountDisplayUnit = (typeof AMOUNT_DISPLAY_UNITS)[number];

export const DEFAULT_AMOUNT_DISPLAY_UNIT: AmountDisplayUnit = "sat";

/** Mask shown for every amount while hidden mode is on (PoC: "*****"). */
export const HIDDEN_AMOUNT_PLACEHOLDER = "•••••";

const SATS_PER_BTC = 100_000_000;

/** The next unit in the tap-cycle (wraps around). */
export const nextAmountDisplayUnit = (unit: AmountDisplayUnit): AmountDisplayUnit => {
  const index = AMOUNT_DISPLAY_UNITS.indexOf(unit);
  return AMOUNT_DISPLAY_UNITS[(index + 1) % AMOUNT_DISPLAY_UNITS.length] ?? unit;
};

/** Parses a persisted unit string; null for anything unknown. */
export const parseAmountDisplayUnit = (
  value: string | null | undefined,
): AmountDisplayUnit | null => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return (AMOUNT_DISPLAY_UNITS as readonly string[]).includes(normalized)
    ? (normalized as AmountDisplayUnit)
    : null;
};

export interface AmountParts {
  /** The formatted number (or the mask when hidden). */
  readonly text: string;
  /** Unit suffix ("sat" / "₿"); empty while hidden. */
  readonly unitLabel: string;
}

export interface FormatAmountOptions {
  readonly unit: AmountDisplayUnit;
  /** Hidden mode: mask the amount entirely. */
  readonly hidden?: boolean;
  /** BCP-47 tag for number formatting (grouping/decimal separators). */
  readonly locale?: string;
}

/** Defensive read: amounts are non-negative integer sats. */
const normalizeAmountSat = (amountSat: number): number =>
  Number.isFinite(amountSat) ? Math.max(0, Math.trunc(amountSat)) : 0;

/**
 * Formats an amount of sats for display. The single formatting authority
 * behind <Amount /> — never hand-format wallet amounts elsewhere.
 *
 * - `sat`: locale-grouped integer, "sat" label.
 * - `btc`: true BTC value (amount / 1e8, up to 8 decimals), "₿" label.
 *   (Divergence from the PoC, which relabels the sat count as ₿.)
 * - hidden: the mask with no unit label, regardless of unit.
 */
export const formatAmountParts = (
  amountSat: number,
  options: FormatAmountOptions,
): AmountParts => {
  if (options.hidden === true) {
    return { text: HIDDEN_AMOUNT_PLACEHOLDER, unitLabel: "" };
  }

  const amount = normalizeAmountSat(amountSat);
  const locale = options.locale ?? "en";

  if (options.unit === "btc") {
    return {
      text: new Intl.NumberFormat(locale, { maximumFractionDigits: 8 }).format(
        amount / SATS_PER_BTC,
      ),
      unitLabel: "₿",
    };
  }

  return {
    text: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(amount),
    unitLabel: "sat",
  };
};
