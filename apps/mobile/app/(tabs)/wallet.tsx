import { Button, Surface, Text } from "@linky/ui";
import { View } from "react-native";

export default function WalletScreen() {
  return (
    <View className="flex-1 gap-4 bg-background px-6 pt-4">
      <Text weight="bold" className="text-2xl">
        Wallet
      </Text>
      <Surface className="gap-3">
        <Text>Placeholder — Cashu wallet lands with the wallet feature.</Text>
        <Button label="Receive" variant="primary" />
        <Button label="Scan" variant="secondary" />
      </Surface>
    </View>
  );
}
