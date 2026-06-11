import { Button, Surface, Text } from "@linky/ui";
import { useRouter } from "expo-router";
import { View } from "react-native";

import { useTranslator } from "../../src/locales";

/**
 * Advanced settings. PoC structure: the keys/backup entry lives here
 * (Menu → Advanced → Backup keys); other rows (mints, relays, Evolu
 * servers…) land with their features.
 */
export default function AdvancedSettingsScreen() {
  const t = useTranslator();
  const router = useRouter();

  return (
    <View className="flex-1 gap-4 bg-background px-6 pt-4">
      <Surface className="gap-3">
        <Text weight="semibold">{t("keys")}</Text>
        {/* #19: pushes the warning-gated backup screen. */}
        <Button
          label={t("backupTitle")}
          variant="secondary"
          onPress={() => router.push("/settings/backup")}
          testID="open-backup"
        />
      </Surface>
      <Surface>
        <Text>{t("shellAdvancedPlaceholder")}</Text>
      </Surface>
    </View>
  );
}
