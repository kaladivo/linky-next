/**
 * PaidOverlayHost — the rendering half of the paid overlay, mounted once in
 * the root layout above the navigator (below toasts, like the PoC z-order:
 * .paid-overlay 80 < .toast-container).
 *
 * PoC look (.paid-overlay/.paid-sheet/.paid-check): dimmed full-screen
 * scrim, dark sheet, green-ringed ✓, bold title — with a spring scale/fade
 * entrance. Tapping anywhere dismisses early; otherwise the store's 3s
 * timer auto-dismisses.
 */
import { Text } from "@linky/ui";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { Animated, Pressable } from "react-native";

import { useTranslator } from "../locales";
import { getPaidOverlaySnapshot, paidOverlay, subscribeToPaidOverlay } from "./paidOverlayStore";

/** PoC .paid-check / .paid-overlay colors (not theme tokens on purpose). */
const CHECK_GREEN = "#22c55e";
const SHEET_BACKGROUND = "#0b1222";
const SCRIM = "rgba(15, 23, 42, 0.62)";

function PaidSheet({ title }: { readonly title: string }) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(progress, {
      toValue: 1,
      useNativeDriver: true,
      friction: 6,
      tension: 60,
    }).start();
  }, [progress]);

  return (
    <Animated.View
      className="w-full max-w-[420px] items-center rounded-2xl border border-surface px-6 py-7"
      style={{
        backgroundColor: SHEET_BACKGROUND,
        opacity: progress,
        transform: [
          {
            scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }),
          },
        ],
      }}
    >
      <Animated.View
        className="mb-4 h-[92px] w-[92px] items-center justify-center rounded-full border-2"
        style={{ borderColor: CHECK_GREEN }}
      >
        <Text weight="bold" className="text-5xl leading-[60px]" style={{ color: CHECK_GREEN }}>
          ✓
        </Text>
      </Animated.View>
      <Text weight="bold" className="text-center text-2xl">
        {title}
      </Text>
    </Animated.View>
  );
}

export function PaidOverlayHost() {
  const state = useSyncExternalStore(subscribeToPaidOverlay, getPaidOverlaySnapshot);
  const t = useTranslator();

  if (!state.visible) return null;

  return (
    <Pressable
      accessibilityRole="alert"
      testID="paid-overlay"
      onPress={() => paidOverlay.dismiss()}
      className="absolute inset-0 items-center justify-center px-6"
      style={{ backgroundColor: SCRIM }}
    >
      <PaidSheet title={state.title ?? t("paid")} />
    </Pressable>
  );
}
