import { Surface, Text } from "@linky/ui";
import { View } from "react-native";

import { useTranslator } from "../../src/locales";

/** Placeholder — the send/scanner flow lands with #39. */
export default function WalletSendScreen() {
  const t = useTranslator();

  return (
    <View className="flex-1 gap-4 bg-background px-6 pt-4">
      <Surface>
        <Text>{t("shellWalletSendPlaceholder")}</Text>
      </Surface>
    </View>
  );
}
