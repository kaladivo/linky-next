import { Surface, Text } from "@linky/ui";
import { View } from "react-native";

import { useTranslator } from "../../src/locales";

/** Placeholder — advanced settings (mints, relays, Evolu servers…) land later. */
export default function AdvancedSettingsScreen() {
  const t = useTranslator();

  return (
    <View className="flex-1 gap-4 bg-background px-6 pt-4">
      <Surface>
        <Text>{t("shellAdvancedPlaceholder")}</Text>
      </Surface>
    </View>
  );
}
