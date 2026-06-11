import { colors, fontFamily } from "@linky/ui";
import { Tabs } from "expo-router";

export default function TabsLayout() {
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
