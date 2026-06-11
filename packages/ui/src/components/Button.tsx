import { Pressable } from "react-native";
import type { PressableProps } from "react-native";
import { twMerge } from "tailwind-merge";

import { Text } from "./Text";

export type ButtonVariant = "primary" | "secondary" | "danger";

const containerClassName: Record<ButtonVariant, string> = {
  primary: "bg-primary active:bg-primary-hover",
  secondary: "bg-surface active:opacity-80",
  danger: "bg-danger active:opacity-80",
};

const labelClassName: Record<ButtonVariant, string> = {
  primary: "text-primary-foreground",
  secondary: "text-foreground",
  danger: "text-background",
};

export interface ButtonProps extends Omit<PressableProps, "children"> {
  /** Button label, rendered in Manrope semibold. */
  label: string;
  variant?: ButtonVariant;
  className?: string;
}

/**
 * Themed button. Variants map to the PoC button tokens:
 * primary (teal on deep teal text), secondary (slate surface),
 * danger (soft red).
 */
export function Button({ label, variant = "primary", className, ...rest }: ButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      className={twMerge(
        "items-center justify-center rounded-xl px-6 py-3 disabled:opacity-40",
        containerClassName[variant],
        className,
      )}
      {...rest}
    >
      <Text weight="semibold" className={labelClassName[variant]}>
        {label}
      </Text>
    </Pressable>
  );
}
