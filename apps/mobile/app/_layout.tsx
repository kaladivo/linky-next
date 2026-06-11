import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

import { EnvironmentBadge } from "../src/components/EnvironmentBadge";

export default function RootLayout() {
  return (
    <>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
      </Stack>
      <EnvironmentBadge />
      <StatusBar style="auto" />
    </>
  );
}
