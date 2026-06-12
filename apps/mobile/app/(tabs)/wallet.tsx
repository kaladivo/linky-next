/**
 * Wallet home (#36; wallet.balance / wallet.display-unit / wallet.warning /
 * wallet.receive / wallet.send / wallet.transactions-link).
 *
 * Mirrors the PoC WalletPage: dismissible early-stage warning, balance hero
 * (tap to cycle sat ↔ btc), Receive/Send actions, subtle transactions link.
 * Additions over the PoC: spendable is the headline with a "total" row when
 * the two differ, and hidden-amount mode is an eye toggle instead of a
 * cycle stop. Balances come through the #35 seam (src/wallet/walletData.ts).
 */
import { Amount, Button, Surface, Text } from "@linky/ui";
import { useRouter } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { useLocale } from "../../src/locales";
import { runAppEffect, useEffectQuery } from "../../src/runtime";
import { getStoreDataVersion, subscribeToStoreData } from "../../src/store/storeManager";
import { useAmountDisplay } from "../../src/wallet/AmountDisplayProvider";
import {
  loadWalletWarningDismissed,
  persistWalletWarningDismissed,
} from "../../src/wallet/displayPreferences";
import { headlineSatBalance, loadWalletData } from "../../src/wallet/walletData";
import { shouldShowWalletWarning, walletWarningApplies } from "../../src/wallet/walletWarning";

/** PoC WalletWarning: ⚠ + title/body + ✕, danger-accented surface. */
function WalletWarningBanner({ onDismiss }: { readonly onDismiss: () => void }) {
  const { t } = useLocale();

  return (
    <Surface className="flex-row gap-3 border-l-4 border-l-danger" testID="wallet-warning">
      <Text className="text-xl">⚠</Text>
      <View className="flex-1 gap-1 pr-6">
        <Text weight="semibold">{t("walletEarlyWarningTitle")}</Text>
        <Text className="text-sm opacity-80">{t("walletEarlyWarningBody")}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("close")}
        hitSlop={12}
        onPress={onDismiss}
        testID="wallet-warning-dismiss"
        className="absolute right-4 top-4"
      >
        <Text className="text-lg leading-5 opacity-70">✕</Text>
      </Pressable>
    </Surface>
  );
}

export default function WalletScreen() {
  const { t, locale } = useLocale();
  const router = useRouter();
  const { unit, hidden, cycleUnit, toggleHidden } = useAmountDisplay();

  // Balances come from the session store (#35/#37 seam); writes bump the
  // store data version, so the balance re-queries after seeds and claims.
  const dataVersion = useSyncExternalStore(subscribeToStoreData, getStoreDataVersion);
  const walletData = useEffectQuery(loadWalletData, [dataVersion]);
  const persistedDismissed = useEffectQuery(loadWalletWarningDismissed);
  const [dismissedOverride, setDismissedOverride] = useState<boolean | null>(null);

  const dismissed =
    dismissedOverride ?? (persistedDismissed.status === "success" && persistedDismissed.data);
  const balance =
    walletData.status === "success" ? headlineSatBalance(walletData.data) : null;

  // PoC parity: when the warning stops applying (balance back under the
  // threshold), the dismissal resets so it re-arms for the next time.
  useEffect(() => {
    if (balance !== null && !walletWarningApplies(balance.spendable) && dismissed) {
      setDismissedOverride(false);
      void runAppEffect(persistWalletWarningDismissed(false));
    }
  }, [balance, dismissed]);

  const dismissWarning = () => {
    setDismissedOverride(true);
    void runAppEffect(persistWalletWarningDismissed(true));
  };

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="gap-4 px-6 pb-8 pt-4"
    >
      {balance !== null && shouldShowWalletWarning(balance.spendable, dismissed) && (
        <WalletWarningBanner onDismiss={dismissWarning} />
      )}

      {/* Balance hero — spendable headline, tap cycles the display unit. */}
      <View className="items-center gap-2 py-8">
        <Text className="text-sm opacity-70">{t("cashuBalance")}</Text>
        {balance === null ? (
          <Text weight="bold" className="text-5xl leading-[56px] opacity-40">
            …
          </Text>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("unitCycleAction")}
            onPress={cycleUnit}
            testID="wallet-balance"
          >
            <Amount amount={balance.spendable} unit={unit} hidden={hidden} locale={locale} size="hero" />
          </Pressable>
        )}
        {balance !== null && balance.total !== balance.spendable && (
          <View className="flex-row items-baseline gap-2" testID="wallet-total">
            <Text className="text-sm opacity-70">{t("walletTotalBalance")}</Text>
            <Amount amount={balance.total} unit={unit} hidden={hidden} locale={locale} />
          </View>
        )}
        {/* Hidden-amount mode: the eye toggle (persisted app-wide). */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={hidden ? t("walletShowAmounts") : t("walletHideAmounts")}
          hitSlop={12}
          onPress={toggleHidden}
          testID="wallet-toggle-hidden"
          className="mt-1 rounded-full bg-surface px-4 py-1.5"
        >
          <Text className="text-base">{hidden ? "🙈" : "👁"}</Text>
        </Pressable>
      </View>

      {/* Receive / Send entry points — flows land with #37 / #39. */}
      <View className="flex-row gap-3">
        <Button
          label={t("walletReceive")}
          variant="primary"
          className="flex-1"
          onPress={() => router.push("/wallet/receive")}
          testID="wallet-receive"
        />
        <Button
          label={t("walletSend")}
          variant="secondary"
          className="flex-1"
          onPress={() => router.push("/wallet/send")}
          testID="wallet-send"
        />
      </View>

      {/* Token list (#38). */}
      <Pressable
        accessibilityRole="button"
        onPress={() => router.push("/wallet/tokens")}
        testID="wallet-tokens"
        className="items-center py-2"
      >
        <Text className="text-primary">{t("tokens")}</Text>
      </Pressable>

      {/* Transactions link (history lands with #43). */}
      <Pressable
        accessibilityRole="button"
        onPress={() => router.push("/wallet/transactions")}
        testID="wallet-transactions"
        className="items-center py-2"
      >
        <Text className="text-primary">{t("transactionsTitle")}</Text>
      </Pressable>

      {/* Mint management (#41). */}
      <Pressable
        accessibilityRole="button"
        onPress={() => router.push("/wallet/mints")}
        testID="wallet-mints"
        className="items-center py-2"
      >
        <Text className="text-primary">{t("mints")}</Text>
      </Pressable>
    </ScrollView>
  );
}
