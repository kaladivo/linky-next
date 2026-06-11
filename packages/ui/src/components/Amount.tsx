import { View } from "react-native";
import type { ViewProps } from "react-native";
import { twMerge } from "tailwind-merge";

import type { AmountDisplayUnit } from "../amount/displayUnit";
import { formatAmountParts } from "../amount/displayUnit";
import { Text } from "./Text";

export type AmountSize = "hero" | "inline";

export interface AmountProps extends Omit<ViewProps, "children"> {
  /** The amount in sats (the wallet's storage unit). */
  amount: number;
  /** Display unit the user cycled to (`wallet.display-unit`). */
  unit: AmountDisplayUnit;
  /** Hidden-amount mode: renders the mask instead of the number. */
  hidden: boolean;
  /** BCP-47 tag for number formatting; pass the app locale. */
  locale?: string;
  /** "hero" = wallet-home headline; "inline" = body-sized (default). */
  size?: AmountSize;
  className?: string;
}

/**
 * Amount — THE contract for rendering wallet amounts (issue #36).
 *
 * Every amount shown anywhere in Linky (wallet home, token lists,
 * transactions, chat payment bubbles, send/receive flows …) MUST render
 * through this component, never via hand-rolled string formatting. That is
 * what makes the feature-map contract hold: "Amount masking must apply
 * consistently everywhere when the hidden unit is active." When `hidden`
 * is true the component shows `HIDDEN_AMOUNT_PLACEHOLDER` and no unit
 * label, whatever the unit.
 *
 * The component is presentation-only: callers own the current unit/hidden
 * state (in the app: `useAmountDisplay()` from
 * apps/mobile/src/wallet/AmountDisplayProvider, persisted via
 * KeyValueStorage) and pass it down. Formatting lives in
 * `formatAmountParts` (../amount/displayUnit.ts) — pure and unit-tested.
 */
export function Amount({
  amount,
  unit,
  hidden,
  locale,
  size = "inline",
  className,
  ...rest
}: AmountProps) {
  const parts = formatAmountParts(amount, {
    unit,
    hidden,
    ...(locale === undefined ? {} : { locale }),
  });

  return (
    <View
      className={twMerge("flex-row items-baseline", size === "hero" ? "gap-2" : "gap-1", className)}
      accessibilityLabel={
        parts.unitLabel === "" ? parts.text : `${parts.text} ${parts.unitLabel}`
      }
      {...rest}
    >
      <Text
        weight={size === "hero" ? "bold" : "semibold"}
        className={size === "hero" ? "text-5xl leading-[56px]" : ""}
      >
        {parts.text}
      </Text>
      {parts.unitLabel !== "" && (
        <Text
          weight="semibold"
          className={size === "hero" ? "text-xl opacity-70" : "text-sm opacity-70"}
        >
          {parts.unitLabel}
        </Text>
      )}
    </View>
  );
}
