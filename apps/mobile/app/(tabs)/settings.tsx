import { Button, Surface, Text } from "@linky/ui";
import { ScrollView } from "react-native";

import { PlatformSmokeTestPanel } from "../../src/dev/PlatformSmokeTestPanel";

export default function SettingsScreen() {
  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 px-6 pb-8 pt-4">
      <Text weight="bold" className="text-2xl">
        Settings
      </Text>
      <Surface className="gap-3">
        <Text>Placeholder — settings land with the settings feature.</Text>
        <Button label="Backup" variant="secondary" />
        <Button label="Delete account" variant="danger" />
      </Surface>
      {/* TEMPORARY (#8): dev-only platform port smoke test; renders null in production. */}
      <PlatformSmokeTestPanel />
    </ScrollView>
  );
}
