import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { appProfile } from "../environment";

const LABELS = {
  development: "DEV",
  staging: "STAGING",
} as const;

/**
 * Non-interactive overlay marking development and staging builds
 * (rewrite-spec.md "Environments": visible badge in non-production builds,
 * none in production). Rendered once in the root layout, above everything.
 */
export function EnvironmentBadge() {
  const insets = useSafeAreaInsets();

  if (appProfile === "production") {
    return null;
  }

  return (
    <View
      pointerEvents="none"
      style={[styles.container, { top: Math.max(insets.top, 12) }]}
      testID="environment-badge"
    >
      <View style={styles.badge}>
        <Text style={styles.label}>{LABELS[appProfile]}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    right: 8,
    zIndex: 1000,
    elevation: 1000,
  },
  badge: {
    backgroundColor: "#E5484D",
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  label: {
    color: "#FFFFFF",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
  },
});
