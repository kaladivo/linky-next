import { Button, Surface, Text } from "@linky/ui";
import { useRouter } from "expo-router";
import { ScrollView } from "react-native";

import { useTranslator } from "../../src/locales";
import { NostrKeysCard } from "../../src/settings/NostrKeysCard";

/**
 * Advanced settings. Live today: backup keys entry (#19 — warning-gated
 * backup screen), Nostr keys (#20 — custom nsec override), and relay
 * settings (#31). The rest (mints, Evolu servers…) lands with #56.
 */
export default function AdvancedSettingsScreen() {
  const t = useTranslator();
  const router = useRouter();

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 px-6 pb-8 pt-4">
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
      <NostrKeysCard />
      <Surface className="gap-3">
        {/* #31: relay list + live status, the PoC's "Nostr relay" row. */}
        <Button
          label={t("nostrRelay")}
          variant="secondary"
          onPress={() => router.push("/settings/relays")}
          testID="open-relays"
        />
      </Surface>
      <Surface>
        <Text>{t("shellAdvancedPlaceholder")}</Text>
      </Surface>
    </ScrollView>
  );
}
