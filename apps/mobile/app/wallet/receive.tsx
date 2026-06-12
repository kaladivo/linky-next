/**
 * Receive — top-up entry (#37; `cashu.topup-quote` entry + `wallet.receive`).
 *
 * PoC TopupPage scope for this issue: amount entry → invoice screen, plus
 * the no-amount receive (own Lightning address QR). Paste/scan receive
 * targets are the scanner issue (#40). A fresh pending quote (cached in its
 * pending transaction row) is surfaced for resume — an already-paid/issued
 * quote claims as soon as its invoice screen reopens.
 */
import { Button, Surface, Text } from "@linky/ui";
import { useRouter } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ScrollView, TextInput, View } from "react-native";

import { useTranslator } from "../../src/locales";
import { getStoreDataVersion, subscribeToStoreData } from "../../src/store/storeManager";
import { useLinkyStore } from "../../src/store/useLinkyStore";
import { loadActivePendingTopups } from "../../src/wallet/topupActions";
import type { PendingTopup } from "../../src/wallet/topupActions";

export default function WalletReceiveScreen() {
  const t = useTranslator();
  const router = useRouter();
  const storeState = useLinkyStore();
  const dataVersion = useSyncExternalStore(subscribeToStoreData, getStoreDataVersion);

  const [amountText, setAmountText] = useState("");
  const [pendingTopups, setPendingTopups] = useState<ReadonlyArray<PendingTopup>>([]);

  const store = storeState.status === "ready" ? storeState.store : null;

  // Resume affordance: fresh pending quotes (stale ones are pruned inside).
  useEffect(() => {
    if (store === null) return;
    let stale = false;
    void loadActivePendingTopups(store, Date.now()).then((pending) => {
      if (!stale) setPendingTopups(pending);
    });
    return () => {
      stale = true;
    };
  }, [store, dataVersion]);

  const amountSat = Number.parseInt(amountText.trim(), 10);
  const valid = Number.isFinite(amountSat) && amountSat > 0;

  const openInvoice = (amount: number) =>
    router.push({ pathname: "/wallet/receive-invoice", params: { amount: String(amount) } });

  const resumable = pendingTopups[0] ?? null;

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 px-6 pb-8 pt-4">
      <Surface className="gap-3">
        <Text weight="semibold">{t("topupTitle")}</Text>
        <View className="flex-row items-center gap-3 rounded-xl bg-background px-4">
          <TextInput
            value={amountText}
            onChangeText={(text) => setAmountText(text.replace(/[^0-9]/g, ""))}
            placeholder={t("topupSetAmount")}
            placeholderTextColor="#94a3b8"
            keyboardType="number-pad"
            testID="topup-amount"
            className="flex-1 py-3 font-sans text-2xl text-foreground"
          />
          <Text className="opacity-70">{t("unitSatName")}</Text>
        </View>
        <Button
          label={t("topupShowInvoice")}
          variant="primary"
          disabled={!valid || store === null}
          onPress={() => valid && openInvoice(amountSat)}
          testID="topup-show-invoice"
        />
      </Surface>

      {/* Re-claim on reopen: an already-issued quote still claims (#32). */}
      {resumable !== null && (
        <Surface className="gap-3" testID="topup-pending">
          <Text className="text-sm opacity-80">
            {t("topupResumePending", { amount: resumable.quote.amountSat })}
          </Text>
          <Button
            label={t("topupInvoiceTitle")}
            variant="secondary"
            onPress={() => openInvoice(resumable.quote.amountSat)}
            testID="topup-pending-open"
          />
        </Surface>
      )}

      {/* No-amount receive: reusable QR of the own Lightning address. */}
      <Button
        label={t("topupNoAmount")}
        variant="secondary"
        onPress={() => router.push("/wallet/receive-address")}
        testID="topup-no-amount"
      />
    </ScrollView>
  );
}
