/**
 * BOLT11 confirmation + pay (#39; `lightning.pay-invoice` /
 * `lightning.confirm-invoice` / `lightning.autopay-limit`).
 *
 * PoC parity (LightningInvoiceConfirmModal + useScannedTextHandler):
 * amount/memo/expiry-countdown confirmation, Pay disabled on insufficient
 * balance, and auto-pay without confirmation when the invoice amount is at
 * or below the configured limit (default 10 000 sat — core `decideAutoPay`).
 * Divergence: amountless invoices show "Unknown amount" with Pay BLOCKED
 * (core's melt contract rejects amountless invoices; the PoC let the
 * attempt fail at the mint).
 */
import { decideAutoPay } from "@linky/core";
import { Amount, Button, Surface, Text } from "@linky/ui";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";

import { useLocale } from "../../src/locales";
import { paidOverlay } from "../../src/paidOverlay";
import { useSession } from "../../src/session/useSession";
import { useLinkyStore } from "../../src/store/useLinkyStore";
import { useAmountDisplay } from "../../src/wallet/AmountDisplayProvider";
import { useEffectQuery } from "../../src/runtime";
import { loadAutoPaySetting } from "../../src/wallet/autoPaySetting";
import { loadInvoicePreview, payBolt11FromWallet } from "../../src/wallet/payActions";
import { formatRemainingLifetime, payFailureMessage } from "../../src/wallet/payModel";
import { headlineSatBalance, loadWalletData } from "../../src/wallet/walletData";
import { paidOverlayTitle } from "../../src/wallet/payOverlayCopy";

export default function WalletPayInvoiceScreen() {
  const { t, locale } = useLocale();
  const router = useRouter();
  const { unit, hidden } = useAmountDisplay();
  const { invoice } = useLocalSearchParams<{ invoice?: string }>();
  const invoiceText = String(invoice ?? "").trim();

  const storeState = useLinkyStore();
  const store = storeState.status === "ready" ? storeState.store : null;
  const session = useSession();
  const seed =
    session.status === "success" && session.data._tag === "IdentityLoaded"
      ? session.data.session.cashuWallet.seed
      : null;

  const preview = useEffectQuery(loadInvoicePreview(invoiceText), [invoiceText]);
  const autoPay = useEffectQuery(loadAutoPaySetting);
  const walletData = useEffectQuery(loadWalletData);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowSec, setNowSec] = useState(() => Date.now() / 1000);
  const autoTriggeredRef = useRef(false);

  const parsed = preview.status === "success" ? preview.data : null;
  const spendable =
    walletData.status === "success" ? headlineSatBalance(walletData.data).spendable : null;
  const insufficient =
    parsed?.amountSat != null && spendable !== null && parsed.amountSat > spendable;

  // PoC modal: the expiry countdown ticks every second while one is known.
  useEffect(() => {
    if (parsed?.expiresAtSec == null) return;
    const interval = setInterval(() => setNowSec(Date.now() / 1000), 1000);
    return () => clearInterval(interval);
  }, [parsed?.expiresAtSec]);

  const pay = async () => {
    if (busy || store === null || seed === null) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await payBolt11FromWallet(store, seed, invoiceText);
      if (outcome.kind === "paid") {
        paidOverlay.show(paidOverlayTitle(t, outcome.amountSat, { unit, hidden, locale }));
        router.dismissAll();
        return;
      }
      const message = payFailureMessage(outcome);
      setError(message.detail === null ? t(message.key) : `${t(message.key)}: ${message.detail}`);
    } finally {
      setBusy(false);
    }
  };

  // Auto-pay (`lightning.autopay-limit`): amounted invoices at or below the
  // limit pay without confirmation — exactly once per screen visit.
  useEffect(() => {
    if (autoTriggeredRef.current) return;
    if (parsed === null || autoPay.status !== "success") return;
    if (store === null || seed === null) return;
    if (decideAutoPay(parsed, autoPay.data) !== "auto-pay") return;
    autoTriggeredRef.current = true;
    void pay();
  }, [parsed, autoPay.status, store, seed]);

  if (preview.status === "success" && parsed === null) {
    return (
      <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 px-6 pt-4">
        <Surface>
          <Text className="text-danger">{t("sendUnrecognized")}</Text>
        </Surface>
        <Button label={t("payCancel")} variant="secondary" onPress={() => router.back()} />
      </ScrollView>
    );
  }

  const expiresLabel = formatRemainingLifetime(
    parsed?.expiresAtSec == null ? null : parsed.expiresAtSec - nowSec,
  );
  const amountless = parsed !== null && parsed.amountSat === null;
  const payDisabled =
    busy || parsed === null || amountless || insufficient || store === null || seed === null;

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 px-6 pb-8 pt-4">
      {/* Amount / memo / expiry summary (PoC confirm-sheet layout). */}
      <View className="items-center gap-2 py-8">
        {parsed === null ? (
          <Text weight="bold" className="text-5xl leading-[56px] opacity-40">
            …
          </Text>
        ) : parsed.amountSat === null ? (
          <Text weight="bold" className="text-3xl" testID="pay-invoice-unknown-amount">
            {t("lightningInvoiceConfirmUnknownAmount")}
          </Text>
        ) : (
          <Amount
            amount={parsed.amountSat}
            unit={unit}
            hidden={hidden}
            locale={locale}
            size="hero"
            testID="pay-invoice-amount"
          />
        )}
        {parsed?.description != null && (
          <Text className="text-center opacity-80" testID="pay-invoice-memo">
            {parsed.description}
          </Text>
        )}
        {expiresLabel !== null && (
          <Text className="text-sm opacity-60" testID="pay-invoice-expiry">
            {expiresLabel}
          </Text>
        )}
      </View>

      {busy && (
        <Surface>
          <Text className="opacity-70" testID="pay-invoice-status">
            {t("payPaying")}
          </Text>
        </Surface>
      )}

      {amountless && (
        <Surface>
          <Text className="text-danger" testID="pay-invoice-amountless">
            {t("payAmountRequired")}
          </Text>
        </Surface>
      )}

      {insufficient && !busy && (
        <Surface>
          <Text className="text-danger" testID="pay-invoice-insufficient">
            {t("payInsufficient")}
          </Text>
        </Surface>
      )}

      {error !== null && !busy && (
        <Surface>
          <Text className="text-danger" testID="pay-invoice-error">
            {error}
          </Text>
        </Surface>
      )}

      <View className="gap-3">
        <Button
          label={t("paySend")}
          variant="primary"
          disabled={payDisabled}
          onPress={() => void pay()}
          testID="pay-invoice-confirm"
        />
        <Button
          label={t("payCancel")}
          variant="secondary"
          disabled={busy}
          onPress={() => router.back()}
          testID="pay-invoice-cancel"
        />
      </View>
    </ScrollView>
  );
}
