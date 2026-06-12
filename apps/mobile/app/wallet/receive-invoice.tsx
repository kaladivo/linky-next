/**
 * Top-up invoice (#37; `cashu.topup-quote` / `cashu.claim-topup`): shows
 * the BOLT11 invoice QR for the entered amount, polls the quote, claims
 * once paid/issued, then paid overlay + back to the wallet.
 *
 * PoC parity (TopupInvoicePage): amount headline, mint note, QR that
 * copies on tap, copy button, 5s polling.
 */
import { Amount, Button, Surface, Text } from "@linky/ui";
import { useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { QrCode } from "../../src/components/QrCode";
import { useLocale } from "../../src/locales";
import { paidOverlay } from "../../src/paidOverlay";
import { useSession } from "../../src/session/useSession";
import { copyToClipboard } from "../../src/settings/nostrKeyActions";
import { useLinkyStore } from "../../src/store/useLinkyStore";
import { toast } from "../../src/toast";
import { useAmountDisplay } from "../../src/wallet/AmountDisplayProvider";
import { useTopupInvoice } from "../../src/wallet/useTopupInvoice";
import { useLocalSearchParams } from "expo-router";

/** Mint display like the PoC: scheme and trailing slashes stripped. */
const mintDisplayName = (mintUrl: string): string =>
  mintUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");

export default function WalletReceiveInvoiceScreen() {
  const { t, locale } = useLocale();
  const router = useRouter();
  const { unit, hidden } = useAmountDisplay();
  const { amount } = useLocalSearchParams<{ amount?: string }>();
  const amountSat = Number.parseInt(String(amount ?? ""), 10);

  const storeState = useLinkyStore();
  const store = storeState.status === "ready" ? storeState.store : null;
  const session = useSession();
  const seed =
    session.status === "success" && session.data._tag === "IdentityLoaded"
      ? session.data.session.cashuWallet.seed
      : null;

  const { state, retry } = useTopupInvoice(store, seed, amountSat);

  // Success feedback exactly once: paid overlay + pop back to the wallet.
  // Failure toast copy depends on the stage: quote creation vs claim.
  const failedStage = state.status === "failed" ? state.stage : null;
  const settledRef = useRef(false);
  useEffect(() => {
    if (settledRef.current) return;
    if (state.status === "claimed") {
      settledRef.current = true;
      paidOverlay.show();
      router.dismissAll();
    } else if (state.status === "failed") {
      settledRef.current = true;
      toast.error(t(failedStage === "claim" ? "topupClaimFailed" : "topupInvoiceFailed"));
    }
  }, [state.status, failedStage, router, t]);
  // Re-arm the one-shot guard when a retry restarts the flow.
  useEffect(() => {
    if (state.status === "preparing") settledRef.current = false;
  }, [state.status]);

  const invoice = state.status === "showing" ? state.pending.quote.invoice : null;

  const copyInvoice = () => {
    if (invoice === null) return;
    void copyToClipboard(invoice).then((ok) => {
      if (ok) toast.success(t("copiedToClipboard"));
      else toast.error(t("copyFailed"));
    });
  };

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 px-6 pb-8 pt-4">
      <View className="items-center gap-1 py-2">
        <Amount amount={amountSat} unit={unit} hidden={hidden} locale={locale} size="hero" />
        {state.status === "showing" && (
          <Text className="text-sm opacity-70" testID="topup-invoice-mint">
            Mint: {mintDisplayName(state.pending.quote.mintUrl)}
          </Text>
        )}
      </View>

      {(state.status === "preparing" || storeState.status !== "ready") && (
        <Surface>
          <Text className="opacity-70">{t("topupFetchingInvoice")}</Text>
        </Surface>
      )}

      {state.status === "showing" && invoice !== null && (
        <View className="gap-4">
          <Pressable accessibilityRole="button" onPress={copyInvoice} testID="topup-invoice-qr">
            <QrCode value={invoice} size={260} />
          </Pressable>
          <Button
            label={t("copy")}
            variant="secondary"
            onPress={copyInvoice}
            testID="topup-invoice-copy"
          />
          <Text className="text-center text-sm opacity-70" testID="topup-invoice-status">
            {state.claiming ? t("topupClaiming") : t("topupWaitingForPayment")}
          </Text>
        </View>
      )}

      {state.status === "expired" && (
        <Surface className="gap-3">
          <Text className="text-danger">{t("topupQuoteExpired")}</Text>
          <Button label={t("topupNewInvoice")} variant="primary" onPress={retry} />
        </Surface>
      )}

      {state.status === "failed" && (
        <Surface className="gap-3">
          <Text className="text-danger">
            {t(state.stage === "claim" ? "topupClaimFailed" : "topupInvoiceFailed")}
          </Text>
          <Button label={t("onboardingRetry")} variant="primary" onPress={retry} />
        </Surface>
      )}
    </ScrollView>
  );
}
