/**
 * No-amount receive (#37; `cashu.no-amount-receive`): the reusable QR of
 * the user's own Lightning address (LNURL-pay style — the address is the
 * scannable target). DISPLAY ONLY here: the hosted npub.cash-style claim
 * sync that routes payments into the wallet is #41.
 */
import { Button, Surface, Text } from "@linky/ui";
import { Pressable, ScrollView, View } from "react-native";

import { QrCode } from "../../src/components/QrCode";
import { useTranslator } from "../../src/locales";
import { useEffectQuery } from "../../src/runtime";
import { copyToClipboard } from "../../src/settings/nostrKeyActions";
import { toast } from "../../src/toast";
import { loadOwnLightningAddress } from "../../src/wallet/ownLightningAddress";

export default function WalletReceiveAddressScreen() {
  const t = useTranslator();
  const addressQuery = useEffectQuery(loadOwnLightningAddress);
  const address = addressQuery.status === "success" ? addressQuery.data : null;

  const copyAddress = () => {
    if (address === null) return;
    void copyToClipboard(address).then((ok) => {
      if (ok) toast.success(t("copiedToClipboard"));
      else toast.error(t("copyFailed"));
    });
  };

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 px-6 pb-8 pt-4">
      <Surface className="gap-1">
        <Text weight="semibold">{t("topupNoAmountTitle")}</Text>
      </Surface>

      {addressQuery.status === "loading" && (
        <Surface>
          <Text className="opacity-70">{t("loadingMore")}</Text>
        </Surface>
      )}

      {(addressQuery.status === "error" ||
        (addressQuery.status === "success" && address === null)) && (
        <Surface>
          <Text className="text-danger">{t("topupNoAmountMissingAddress")}</Text>
        </Surface>
      )}

      {address !== null && (
        <View className="gap-4">
          <Pressable accessibilityRole="button" onPress={copyAddress} testID="receive-address-qr">
            <QrCode value={address} size={260} />
          </Pressable>
          <Text
            className="text-center text-sm opacity-80"
            selectable
            testID="receive-address-text"
          >
            {address}
          </Text>
          <Button
            label={t("copy")}
            variant="secondary"
            onPress={copyAddress}
            testID="receive-address-copy"
          />
        </View>
      )}
    </ScrollView>
  );
}
