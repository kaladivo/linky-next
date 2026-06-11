import { Surface, Text } from "@linky/ui";
import { Stack, useLocalSearchParams } from "expo-router";
import { View } from "react-native";

import { useTranslator } from "../../src/locales";

/** Placeholder — the chat screen lands with the messaging feature. */
export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTranslator();

  return (
    <>
      <Stack.Screen options={{ title: t("conversations") }} />
      <View className="flex-1 gap-4 bg-background px-6 pt-4">
        <Surface>
          <Text>{t("shellChatPlaceholder", { id: id ?? "?" })}</Text>
        </Surface>
      </View>
    </>
  );
}
