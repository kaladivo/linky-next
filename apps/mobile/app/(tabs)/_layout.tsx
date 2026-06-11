import { colors, fontFamily, Text } from "@linky/ui";
import { Redirect, Tabs } from "expo-router";
import { View } from "react-native";

import { useSession } from "../../src/session/useSession";

/**
 * Boot gate (#14): the tabs render only when an identity is persisted; with
 * no identity the user is redirected to /onboarding (placeholder until #17).
 * Kept inside the tabs layout so app/_layout.tsx stays untouched (#16 is
 * reworking the app shell in parallel).
 */
export default function TabsLayout() {
  const session = useSession();

  if (session.status === "loading") {
    return null;
  }
  if (session.status === "error") {
    // SecureStorageError / IdentitySessionCorruptedError — typed, never
    // carrying secret material. Recovery UX is part of #17.
    return (
      <View className="flex-1 items-center justify-center bg-background px-6">
        <Text className="text-danger">Could not load your account ({session.error._tag}).</Text>
      </View>
    );
  }
  if (session.data._tag === "NoIdentity") {
    return <Redirect href="/onboarding" />;
  }

  return (
    <Tabs
      screenOptions={{
        sceneStyle: { backgroundColor: colors.background },
        headerStyle: { backgroundColor: colors.background },
        headerShadowVisible: false,
        headerTintColor: colors.foreground,
        headerTitleStyle: { fontFamily: fontFamily["sans-bold"][0] },
        tabBarStyle: { backgroundColor: colors.background, borderTopColor: colors.surface },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.foreground,
        tabBarLabelStyle: { fontFamily: fontFamily["sans-semibold"][0] },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Contacts" }} />
      <Tabs.Screen name="wallet" options={{ title: "Wallet" }} />
      <Tabs.Screen name="settings" options={{ title: "Settings" }} />
    </Tabs>
  );
}
