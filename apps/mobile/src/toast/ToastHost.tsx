/**
 * ToastHost — the rendering half of the toast system, mounted once in the
 * root layout (app/_layout.tsx) above the navigator.
 *
 * Bottom overlay (above the tab bar, like the PoC's .toast-container),
 * themed with @linky/ui tokens, dark-theme native. Tapping a toast
 * dismisses it early; otherwise the store's timer auto-dismisses.
 */
import { Text } from "@linky/ui";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSyncExternalStore } from "react";

import type { ToastVariant } from "./toastQueue";
import { getToastSnapshot, subscribeToToasts, toast } from "./toastStore";

/** Variant accent: left border + label color on the shared surface panel. */
const variantClassName: Record<ToastVariant, string> = {
  success: "border-l-primary",
  error: "border-l-danger",
  info: "border-l-foreground",
};

/** Keeps toasts clear of the bottom tab bar (~56pt) plus breathing room. */
const TAB_BAR_CLEARANCE = 72;

export function ToastHost() {
  const toasts = useSyncExternalStore(subscribeToToasts, getToastSnapshot);
  const insets = useSafeAreaInsets();

  if (toasts.length === 0) return null;

  return (
    <View
      pointerEvents="box-none"
      className="absolute inset-x-0 items-center gap-2 px-6"
      style={{ bottom: insets.bottom + TAB_BAR_CLEARANCE }}
    >
      {toasts.map((item) => (
        <Pressable
          key={item.id}
          accessibilityRole="alert"
          testID={`toast-${item.variant}`}
          onPress={() => toast.dismiss(item.id)}
          className={`w-full rounded-2xl border-l-4 bg-surface px-4 py-3 shadow-lg ${variantClassName[item.variant]}`}
        >
          <Text className="text-sm">{item.message}</Text>
        </Pressable>
      ))}
    </View>
  );
}
