import { Button, Surface, Text } from "@linky/ui";
import { useRouter } from "expo-router";
import { View } from "react-native";

import { useTranslator } from "../../src/locales";

export default function WalletScreen() {
  const t = useTranslator();
  const router = useRouter();

  return (
    <View className="flex-1 gap-4 bg-background px-6 pt-4">
      <Text weight="bold" className="text-2xl">
        {t("wallet")}
      </Text>
      <Surface className="gap-3">
        <Text>{t("shellWalletPlaceholder")}</Text>
        <Button label={t("walletReceive")} variant="primary" />
        <Button label={t("walletSend")} variant="secondary" />
        {/* Placeholder push — proves the wallet/token/[id] stack route until
            the real token list lands. */}
        <Button
          label={`${t("tokens")} → demo`}
          variant="secondary"
          onPress={() => router.push("/wallet/token/demo")}
        />
      </Surface>
    </View>
  );
}
