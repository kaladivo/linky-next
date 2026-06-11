import { View } from "react-native";
import type { ViewProps } from "react-native";
import { twMerge } from "tailwind-merge";

export interface SurfaceProps extends ViewProps {
  className?: string;
}

/**
 * Secondary surface container: raised slate panel (#1e293b) with rounded
 * corners, sitting on the flat app background.
 */
export function Surface({ className, ...rest }: SurfaceProps) {
  return <View className={twMerge("rounded-2xl bg-surface p-4", className)} {...rest} />;
}
