import { Button, Surface, Text } from "@linky/ui";
import { useRouter } from "expo-router";
import { View } from "react-native";

import { useTranslator } from "../../src/locales";

export default function ContactsScreen() {
  const t = useTranslator();
  const router = useRouter();

  return (
    <View className="flex-1 gap-4 bg-background px-6 pt-4">
      <Text weight="bold" className="text-2xl">
        {t("contactsTitle")}
      </Text>
      <Surface className="gap-3">
        <Text>{t("shellContactsPlaceholder")}</Text>
        <Button label={t("addContact")} variant="primary" />
        {/* Placeholder pushes — prove the contact/[id] and chat/[id] stack
            routes until the real contact list lands. */}
        <Button
          label={`${t("contactsTitle")} → demo`}
          variant="secondary"
          onPress={() => router.push("/contact/demo")}
        />
        <Button
          label={`${t("conversations")} → demo`}
          variant="secondary"
          onPress={() => router.push("/chat/demo")}
        />
      </Surface>
    </View>
  );
}
