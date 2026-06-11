import { Surface, Text } from "@linky/ui";
import { View } from "react-native";

import { useTranslator } from "../../src/locales";

/** Placeholder — the receive/top-up flow lands with #37. */
export default function WalletReceiveScreen() {
  const t = useTranslator();

  return (
    <View className="flex-1 gap-4 bg-background px-6 pt-4">
      <Surface>
        <Text>{t("shellWalletReceivePlaceholder")}</Text>
      </Surface>
    </View>
  );
}
