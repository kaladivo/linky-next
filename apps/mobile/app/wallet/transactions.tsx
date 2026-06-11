import { Surface, Text } from "@linky/ui";
import { View } from "react-native";

import { useTranslator } from "../../src/locales";

/** Placeholder — local payment history lands with #43. */
export default function WalletTransactionsScreen() {
  const t = useTranslator();

  return (
    <View className="flex-1 gap-4 bg-background px-6 pt-4">
      <Surface>
        <Text>{t("shellWalletTransactionsPlaceholder")}</Text>
      </Surface>
    </View>
  );
}
