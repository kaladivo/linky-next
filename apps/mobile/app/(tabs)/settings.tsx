import { Button, Surface, Text } from "@linky/ui";
import { View } from "react-native";

export default function SettingsScreen() {
  return (
    <View className="flex-1 gap-4 bg-background px-6 pt-4">
      <Text weight="bold" className="text-2xl">
        Settings
      </Text>
      <Surface className="gap-3">
        <Text>Placeholder — settings land with the settings feature.</Text>
        <Button label="Backup" variant="secondary" />
        <Button label="Delete account" variant="danger" />
      </Surface>
    </View>
  );
}
