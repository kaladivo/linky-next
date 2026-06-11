import { Surface, Text } from "@linky/ui";
import { Stack, useLocalSearchParams } from "expo-router";
import { View } from "react-native";

import { useTranslator } from "../../src/locales";

/** Placeholder — the contact detail screen lands with the contacts feature. */
export default function ContactDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTranslator();

  return (
    <>
      <Stack.Screen options={{ title: t("contactsTitle") }} />
      <View className="flex-1 gap-4 bg-background px-6 pt-4">
        <Surface>
          <Text>{t("shellContactDetailPlaceholder", { id: id ?? "?" })}</Text>
        </Surface>
      </View>
    </>
  );
}
