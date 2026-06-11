/**
 * Main surfaces (shell.contacts-wallet-tabs): Contacts and Wallet as
 * material top tabs rendered at the BOTTOM via expo-router's built-in
 * `TopTabs` (expo-router/js-top-tabs — SDK 56 vendors material-top-tabs;
 * importing @react-navigation/* directly is a bundler error). This gives
 * the PoC behavior — bottom tab bar + horizontal swipe between the two
 * surfaces (react-native-pager-view) — while each surface keeps its own
 * Expo Router URL ("/" and "/wallet").
 *
 * Settings is deliberately NOT a tab: the PoC bottom nav has only
 * Contacts/Wallet, with settings behind the header menu (☰). Here the
 * header menu glyph pushes the /settings stack screen.
 */
import { colors, fontFamily, Text } from "@linky/ui";
import { Link } from "expo-router";
import { TopTabs } from "expo-router/js-top-tabs";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useTranslator } from "../../src/locales";

/** App title + menu glyph (PoC's ☰) opening Settings as a pushed screen. */
function ShellHeader() {
  const t = useTranslator();
  const insets = useSafeAreaInsets();

  return (
    <View
      className="flex-row items-center justify-between px-6 pb-1"
      style={{ paddingTop: insets.top + 4 }}
    >
      <Text weight="bold" className="text-2xl">
        {t("appTitle")}
      </Text>
      <Link href="/settings" asChild>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("settings")}
          hitSlop={12}
          testID="open-settings"
        >
          <Text className="text-2xl leading-7">☰</Text>
        </Pressable>
      </Link>
    </View>
  );
}

export default function TabsLayout() {
  const t = useTranslator();
  const insets = useSafeAreaInsets();

  return (
    // Bottom inset on the wrapper keeps the bottom-positioned tab bar above
    // the home indicator (material top tabs are not safe-area aware).
    <View className="flex-1 bg-background" style={{ paddingBottom: insets.bottom }}>
      <ShellHeader />
      <TopTabs
        tabBarPosition="bottom"
        screenOptions={{
          sceneStyle: { backgroundColor: colors.background },
          tabBarStyle: {
            backgroundColor: colors.background,
            borderTopWidth: 1,
            borderTopColor: colors.surface,
          },
          tabBarActiveTintColor: colors.primary,
          tabBarInactiveTintColor: colors.foreground,
          tabBarLabelStyle: {
            fontFamily: fontFamily["sans-semibold"][0],
            fontSize: 13,
            textTransform: "none",
          },
          // The bar sits at the bottom, so the active indicator goes on its
          // top edge.
          tabBarIndicatorStyle: { backgroundColor: colors.primary, top: 0, height: 2 },
        }}
      >
        <TopTabs.Screen name="index" options={{ title: t("contactsTitle") }} />
        <TopTabs.Screen name="wallet" options={{ title: t("wallet") }} />
      </TopTabs>
    </View>
  );
}
