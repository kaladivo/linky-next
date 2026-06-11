import { Surface, Text } from "@linky/ui";
import { Stack, useLocalSearchParams } from "expo-router";
import { View } from "react-native";

import { useTranslator } from "../../../src/locales";

/** Placeholder — the Cashu token detail lands with the wallet feature. */
export default function TokenDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTranslator();

  return (
    <>
      <Stack.Screen options={{ title: t("tokens") }} />
      <View className="flex-1 gap-4 bg-background px-6 pt-4">
        <Surface>
          <Text>{t("shellTokenDetailPlaceholder", { id: id ?? "?" })}</Text>
        </Surface>
      </View>
    </>
  );
}
