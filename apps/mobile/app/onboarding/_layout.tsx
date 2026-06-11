/**
 * Onboarding flow (#17) — first-run steps as a nested stack:
 *
 *   index    language choice (cs/en) BEFORE account setup
 *   create   welcome + create account (core createIdentitySession)
 *   restore  "I'm returning" — 20-word backup restore (#18)
 *   profile  name + deterministic avatar (+ optional custom photo)
 *   backup   20-word backup prompt — strongly prompted, never blocking
 *
 * The boot gate in (tabs)/_layout redirects here while no identity is
 * persisted; once the identity exists mid-flow, navigation proceeds
 * explicitly (create → profile → backup → tabs). Relaunching mid-flow lands
 * in the tabs (backup must never gate app entry — PoC contract).
 */
import { colors } from "@linky/ui";
import { Stack } from "expo-router";

export default function OnboardingLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background },
      }}
    />
  );
}
