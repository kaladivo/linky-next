import "../global.css";

import {
  Manrope_400Regular,
  Manrope_600SemiBold,
  Manrope_700Bold,
  useFonts,
} from "@expo-google-fonts/manrope";
import { colors, fontFamily } from "@linky/ui";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";

// Keep the native splash visible until Manrope is loaded so the first frame
// already renders with the brand font.
void SplashScreen.preventAutoHideAsync();

import { EnvironmentBadge } from "../src/components/EnvironmentBadge";
import { LocaleProvider, useTranslator } from "../src/locales";
import { PaidOverlayHost } from "../src/paidOverlay";
import { DeferredStartup } from "../src/startup/DeferredStartup";
import { ToastHost } from "../src/toast";
import { AmountDisplayProvider } from "../src/wallet/AmountDisplayProvider";

/**
 * Route map (shell.navigate):
 *   (tabs)            Contacts + Wallet pager (bottom tabs + swipe), no header.
 *   settings/*        Pushed over the tabs (PoC: settings opens from the
 *                     header menu, it is NOT a bottom tab).
 *   contact/[id], chat/[id], wallet/token/[id]
 *                     Detail placeholders, native-stack push with header.
 */
function RootNavigator() {
  const t = useTranslator();

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background },
        headerStyle: { backgroundColor: colors.background },
        headerShadowVisible: false,
        headerTintColor: colors.foreground,
        headerTitleStyle: { fontFamily: fontFamily["sans-bold"][0] },
        headerBackButtonDisplayMode: "minimal",
      }}
    >
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="settings/index" options={{ headerShown: true, title: t("settings") }} />
      <Stack.Screen
        name="settings/advanced"
        options={{ headerShown: true, title: t("advanced") }}
      />
      <Stack.Screen
        name="settings/backup"
        options={{ headerShown: true, title: t("backupTitle") }}
      />
      <Stack.Screen name="contact/new" options={{ headerShown: true, title: t("newContact") }} />
      <Stack.Screen name="contact/[id]" options={{ headerShown: true }} />
      <Stack.Screen name="chat/[id]" options={{ headerShown: true }} />
      <Stack.Screen name="wallet/token/[id]" options={{ headerShown: true }} />
      {/* Wallet home entry points (#36); receive/top-up flow is #37. */}
      <Stack.Screen
        name="wallet/receive"
        options={{ headerShown: true, title: t("walletReceive") }}
      />
      <Stack.Screen
        name="wallet/receive-invoice"
        options={{ headerShown: true, title: t("topupInvoiceTitle") }}
      />
      <Stack.Screen
        name="wallet/receive-address"
        options={{ headerShown: true, title: t("topupNoAmountTitle") }}
      />
      <Stack.Screen name="wallet/send" options={{ headerShown: true, title: t("walletSend") }} />
      <Stack.Screen
        name="wallet/transactions"
        options={{ headerShown: true, title: t("transactionsTitle") }}
      />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Manrope_400Regular,
    Manrope_600SemiBold,
    Manrope_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      void SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) {
    return null;
  }

  // Order matters for the overlays: the paid overlay paints above the
  // navigator, toasts above it (PoC z-order), the environment badge above
  // everything.
  return (
    <LocaleProvider>
      <AmountDisplayProvider>
        <RootNavigator />
        <DeferredStartup />
        <PaidOverlayHost />
        <ToastHost />
        <EnvironmentBadge />
        <StatusBar style="light" />
      </AmountDisplayProvider>
    </LocaleProvider>
  );
}
