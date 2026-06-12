import "../global.css";
// TextDecoder/TextEncoder for Hermes — MUST precede anything that parses
// Cashu tokens (cashu-ts CBOR decode needs TextDecoder; #44).
import "../lib/textEncodingPolyfill";

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
 *   profile/*         Own profile view + editor (#30), pushed from the
 *                     shell-header avatar (PoC: topbar profile button).
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
      {/* Profile (#30): view + edit, pushed from the shell-header avatar
          (the PoC's topbar profile button). */}
      <Stack.Screen name="profile/index" options={{ headerShown: true, title: t("profile") }} />
      <Stack.Screen
        name="profile/edit"
        options={{ headerShown: true, title: t("profileEditTitle") }}
      />
      <Stack.Screen
        name="settings/advanced"
        options={{ headerShown: true, title: t("advanced") }}
      />
      <Stack.Screen
        name="settings/backup"
        options={{ headerShown: true, title: t("backupTitle") }}
      />
      {/* Relay settings (#31): list/add/remove + live status. */}
      <Stack.Screen
        name="settings/relays"
        options={{ headerShown: true, title: t("nostrRelay") }}
      />
      <Stack.Screen name="contact/new" options={{ headerShown: true, title: t("newContact") }} />
      {/* Scanner surface (#47): camera/paste/gallery/manual input. Custom
          in-screen header (PoC scan sheet); result routing lands with #48
          (contract: src/scanner/scanContract.ts). */}
      <Stack.Screen name="scanner" options={{ presentation: "fullScreenModal" }} />
      <Stack.Screen name="contact/[id]" options={{ headerShown: true }} />
      <Stack.Screen name="chat/[id]" options={{ headerShown: true }} />
      <Stack.Screen
        name="wallet/token/[id]"
        options={{ headerShown: true, title: t("cashuToken") }}
      />
      {/* Token list & detail (#38). */}
      <Stack.Screen name="wallet/tokens" options={{ headerShown: true, title: t("tokens") }} />
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
      {/* LNURL-withdraw (#40). */}
      <Stack.Screen
        name="wallet/lnurl-withdraw"
        options={{ headerShown: true, title: t("lnurlWithdrawTitle") }}
      />
      <Stack.Screen name="wallet/send" options={{ headerShown: true, title: t("walletSend") }} />
{/* Mint management (#41): presets/custom/main-mint + detail. */}
      <Stack.Screen name="wallet/mints" options={{ headerShown: true, title: t("mints") }} />
      <Stack.Screen
        name="wallet/mint/[url]"
        options={{ headerShown: true, title: t("mints") }}
      />
      {/* Pay flows (#39): BOLT11 confirmation + Lightning-address/LNURL pay. */}
      <Stack.Screen
        name="wallet/pay-invoice"
        options={{ headerShown: true, title: t("pay") }}
      />
      <Stack.Screen
        name="wallet/pay-address"
        options={{ headerShown: true, title: t("payTo") }}
      />
      {/* Transaction history + detail (#43). */}
      <Stack.Screen
        name="wallet/transactions"
        options={{ headerShown: true, title: t("transactionsTitle") }}
      />
      <Stack.Screen
        name="wallet/transaction/[id]"
        options={{ headerShown: true, title: t("transactionDetailTitle") }}
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
