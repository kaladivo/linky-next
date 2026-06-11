import { Button, Surface, Text } from "@linky/ui";
import { View } from "react-native";

export default function ContactsScreen() {
  return (
    <View className="flex-1 gap-4 bg-background px-6 pt-4">
      <Text weight="bold" className="text-2xl">
        Contacts
      </Text>
      <Surface className="gap-3">
        <Text>Placeholder — contact list lands with the contacts feature.</Text>
        <Button label="Add contact" variant="primary" />
      </Surface>
    </View>
  );
}
