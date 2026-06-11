import { Surface, Text } from "@linky/ui";
import { ScrollView } from "react-native";

import { useTranslator } from "../../src/locales";
import { NostrKeysCard } from "../../src/settings/NostrKeysCard";

/**
 * Advanced settings. Live today: Nostr keys (#20 — custom nsec override).
 * The rest (mints, relays, Evolu servers…) lands with #56.
 */
export default function AdvancedSettingsScreen() {
  const t = useTranslator();

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 px-6 pb-8 pt-4">
      <NostrKeysCard />
      <Surface>
        <Text>{t("shellAdvancedPlaceholder")}</Text>
      </Surface>
    </ScrollView>
  );
}
