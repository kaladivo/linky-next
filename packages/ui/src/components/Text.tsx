import { Text as RNText } from "react-native";
import type { TextProps as RNTextProps } from "react-native";
import { twMerge } from "tailwind-merge";

export type TextWeight = "regular" | "semibold" | "bold";

const weightClassName: Record<TextWeight, string> = {
  regular: "font-sans",
  semibold: "font-sans-semibold",
  bold: "font-sans-bold",
};

export interface TextProps extends RNTextProps {
  /** Manrope weight; each weight is a separate expo-font family. */
  weight?: TextWeight;
  className?: string;
}

/**
 * Themed text: Manrope + body foreground color (#e2e8f0) by default.
 * Override or extend via className (e.g. "text-primary text-lg").
 */
export function Text({ weight = "regular", className, ...rest }: TextProps) {
  return (
    <RNText
      className={twMerge(weightClassName[weight], "text-base text-foreground", className)}
      {...rest}
    />
  );
}
