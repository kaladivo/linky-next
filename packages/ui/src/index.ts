/**
 * @linky/ui — shared React Native primitives, NativeWind theme, design tokens.
 *
 * The Tailwind preset lives at @linky/ui/tailwind-preset (CJS, consumable by
 * any client's tailwind.config.js); runtime token values are re-exported here.
 */
export { colors, fontFamily, spacing, lineHeight } from "./tokens";
export {
  AMOUNT_DISPLAY_UNITS,
  DEFAULT_AMOUNT_DISPLAY_UNIT,
  HIDDEN_AMOUNT_PLACEHOLDER,
  formatAmountParts,
  nextAmountDisplayUnit,
  parseAmountDisplayUnit,
} from "./amount/displayUnit";
export type { AmountDisplayUnit, AmountParts, FormatAmountOptions } from "./amount/displayUnit";
export { Amount } from "./components/Amount";
export type { AmountProps, AmountSize } from "./components/Amount";
export { Button } from "./components/Button";
export type { ButtonProps, ButtonVariant } from "./components/Button";
export { Text } from "./components/Text";
export type { TextProps, TextWeight } from "./components/Text";
export { Surface } from "./components/Surface";
export type { SurfaceProps } from "./components/Surface";
