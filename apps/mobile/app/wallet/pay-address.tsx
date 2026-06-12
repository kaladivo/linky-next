/**
 * Pay a Lightning address / LNURL-pay target (#39; `lightning.pay-address`,
 * `lnurl.pay`).
 *
 * PoC parity (LnAddressPayPage): metadata preview (loading / error /
 * description / min–max range hint / fixed-amount lock), amount input with
 * range + balance validation, "available:" line that fills the full
 * balance, paid overlay with the recipient name, LUD-09 success-action
 * status, and the save-as-contact offer after paying an unknown address.
 */
import { fetchLnurlPayMetadata, lnurlDisplayText } from "@linky/core";
import { Amount, Button, Surface, Text } from "@linky/ui";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";

import { useLocale } from "../../src/locales";
import { paidOverlay } from "../../src/paidOverlay";
import { useEffectQuery } from "../../src/runtime";
import { useSession } from "../../src/session/useSession";
import { useLinkyStore } from "../../src/store/useLinkyStore";
import { toast } from "../../src/toast";
import { useAmountDisplay } from "../../src/wallet/AmountDisplayProvider";
import {
  findContactByLnAddress,
  lnAddressOf,
  payLnurlTargetFromWallet,
  saveRecipientAsContact,
} from "../../src/wallet/payActions";
import { payFailureMessage } from "../../src/wallet/payModel";
import { paidOverlayTitle } from "../../src/wallet/payOverlayCopy";
import { headlineSatBalance, loadWalletData } from "../../src/wallet/walletData";
import type { ContactRecord } from "@linky/evolu-store";
import type { LnurlSuccessAction } from "@linky/core";

export default function WalletPayAddressScreen() {
  const { t, locale } = useLocale();
  const router = useRouter();
  const { unit, hidden } = useAmountDisplay();
  const { target: targetParam } = useLocalSearchParams<{ target?: string }>();
  const target = String(targetParam ?? "").trim();
  const lnAddress = lnAddressOf(target);

  const storeState = useLinkyStore();
  const store = storeState.status === "ready" ? storeState.store : null;
  const session = useSession();
  const seed =
    session.status === "success" && session.data._tag === "IdentityLoaded"
      ? session.data.session.cashuWallet.seed
      : null;

  // LNURL-pay metadata preview; typed Lnurl errors render as the PoC's
  // "couldn't load" line with the reason.
  const metadataState = useEffectQuery(fetchLnurlPayMetadata(target), [target]);
  const walletData = useEffectQuery(loadWalletData);
  const spendable =
    walletData.status === "success" ? headlineSatBalance(walletData.data).spendable : 0;

  const [amountText, setAmountText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [knownContact, setKnownContact] = useState<ContactRecord | null>(null);
  const [savePromptAmount, setSavePromptAmount] = useState<number | null>(null);

  // Known-recipient lookup (PoC: a known address pays under the contact).
  useEffect(() => {
    if (lnAddress === null || store === null) return;
    let stale = false;
    void findContactByLnAddress(lnAddress).then((contact) => {
      if (!stale) setKnownContact(contact);
    });
    return () => {
      stale = true;
    };
  }, [lnAddress, store]);

  const metadata = metadataState.status === "success" ? metadataState.data : null;
  // PoC copy: "couldn't load: <service reason>" (the tag only as fallback).
  const metadataError =
    metadataState.status === "error"
      ? `${t("lnurlPayLoadFailed")}: ${
          "reason" in metadataState.error && typeof metadataState.error.reason === "string"
            ? metadataState.error.reason
            : metadataState.error._tag
        }`
      : null;

  const isFixedAmount =
    metadata !== null && metadata.minSendableSat === metadata.maxSendableSat;
  const fixedAmountSat = isFixedAmount && metadata !== null ? metadata.minSendableSat : null;

  // Fixed-amount targets lock the input to the required amount (PoC).
  useEffect(() => {
    if (fixedAmountSat === null) return;
    setAmountText((current) =>
      current === String(fixedAmountSat) ? current : String(fixedAmountSat),
    );
  }, [fixedAmountSat]);

  const amountSat = Number.parseInt(amountText.trim(), 10);
  const hasAmount = Number.isFinite(amountSat) && amountSat > 0;

  const amountBelowRange =
    metadata !== null && hasAmount && amountSat < metadata.minSendableSat;
  const amountAboveRange =
    metadata !== null && hasAmount && amountSat > metadata.maxSendableSat;

  const invalid =
    !hasAmount ||
    amountSat > spendable ||
    metadata === null ||
    amountBelowRange ||
    amountAboveRange ||
    busy ||
    store === null ||
    seed === null;

  let validationHint: string | null = null;
  if (hasAmount && amountSat > spendable) {
    validationHint = t("payInsufficient");
  } else if (amountBelowRange && metadata !== null) {
    validationHint = t("lnurlPayAmountTooLow", { min: metadata.minSendableSat });
  } else if (amountAboveRange && metadata !== null) {
    validationHint = t("lnurlPayAmountTooHigh", { max: metadata.maxSendableSat });
  }

  const displayName = knownContact?.name?.trim() || lnAddress || lnurlDisplayText(target);

  const showSuccessActionStatus = (successAction: LnurlSuccessAction | null) => {
    if (successAction === null) return;
    if (successAction._tag === "message") {
      toast.success(t("lnurlSuccessActionMessage", { message: successAction.message }));
    } else {
      toast.success(
        t("lnurlSuccessActionUrl", {
          description: successAction.description ?? "",
          url: successAction.url,
        }),
      );
    }
  };

  const pay = async () => {
    if (invalid || store === null || seed === null) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await payLnurlTargetFromWallet(store, seed, {
        target,
        amountSat,
        contactId: knownContact?.id,
      });
      if (outcome.kind === "paid") {
        paidOverlay.show(
          paidOverlayTitle(t, outcome.amountSat, { unit, hidden, locale }, displayName),
        );
        showSuccessActionStatus(outcome.successAction);
        // Unknown address-shaped recipient → offer to save (PoC
        // postPaySaveContact).
        if (lnAddress !== null && knownContact === null) {
          setSavePromptAmount(outcome.amountSat);
        } else {
          router.dismissAll();
        }
        return;
      }
      const message = payFailureMessage(outcome);
      setError(message.detail === null ? t(message.key) : `${t(message.key)}: ${message.detail}`);
    } finally {
      setBusy(false);
    }
  };

  const saveContact = () => {
    if (lnAddress === null) return;
    void saveRecipientAsContact(lnAddress).then(() => {
      toast.success(t("contactSaved"));
      router.dismissAll();
    });
  };

  // Post-success: the save-as-contact offer replaces the pay form.
  if (savePromptAmount !== null && lnAddress !== null) {
    return (
      <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 px-6 pt-4">
        <Surface className="gap-3" testID="pay-address-save-prompt">
          <Text weight="semibold">{t("saveContactPromptTitle")}</Text>
          <Text className="opacity-80">
            {t("saveContactPromptBody", {
              amount: savePromptAmount,
              unit: "sat",
              lnAddress,
            })}
          </Text>
          <Button
            label={t("saveContactPromptSave")}
            variant="primary"
            onPress={saveContact}
            testID="pay-address-save-contact"
          />
          <Button
            label={t("saveContactPromptSkip")}
            variant="secondary"
            onPress={() => router.dismissAll()}
            testID="pay-address-skip-save"
          />
        </Surface>
      </ScrollView>
    );
  }

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 px-6 pb-8 pt-4">
      {/* Recipient header (PoC contact-header): name/address + available. */}
      <View className="items-center gap-1 py-4">
        <Text weight="semibold" className="text-lg" numberOfLines={1} testID="pay-address-target">
          {displayName}
        </Text>
        {knownContact?.name != null && lnAddress !== null && (
          <Text className="text-sm opacity-70" numberOfLines={1}>
            {lnAddress}
          </Text>
        )}
        <Pressable
          accessibilityRole="button"
          disabled={spendable <= 0 || isFixedAmount}
          onPress={() => setAmountText(String(spendable))}
          testID="pay-address-available"
        >
          <View className="flex-row items-baseline gap-1">
            <Text className="text-sm opacity-70">{t("availablePrefix")}</Text>
            <Amount amount={spendable} unit={unit} hidden={hidden} locale={locale} />
          </View>
        </Pressable>
      </View>

      {/* Metadata preview: loading / failure / description / range hints. */}
      {metadataState.status === "loading" && (
        <Surface>
          <Text className="opacity-70" testID="pay-address-loading">
            {t("lnurlPayLoading")}
          </Text>
        </Surface>
      )}
      {metadataError !== null && (
        <Surface>
          <Text className="text-danger" testID="pay-address-load-error">
            {metadataError}
          </Text>
        </Surface>
      )}
      {metadata !== null && (
        <Surface className="gap-2" testID="pay-address-preview">
          {metadata.description !== null && (
            <Text className="opacity-80" testID="pay-address-description">
              {metadata.description}
            </Text>
          )}
          <Text className="text-sm opacity-70" testID="pay-address-range">
            {isFixedAmount
              ? t("lnurlPayFixedHint", { amount: metadata.minSendableSat })
              : t("lnurlPayRangeHint", {
                  min: metadata.minSendableSat,
                  max: metadata.maxSendableSat,
                })}
          </Text>
        </Surface>
      )}

      {/* Amount entry (sat); fixed-amount targets lock it. */}
      <Surface className="gap-3">
        <View className="flex-row items-center gap-3 rounded-xl bg-background px-4">
          <TextInput
            value={amountText}
            onChangeText={(text) => {
              setError(null);
              setAmountText(text.replace(/[^0-9]/g, ""));
            }}
            editable={!isFixedAmount && !busy}
            placeholder={t("payAmount")}
            placeholderTextColor="#94a3b8"
            keyboardType="number-pad"
            testID="pay-address-amount"
            className="flex-1 py-3 font-sans text-2xl text-foreground"
          />
          <Text className="opacity-70">{t("unitSatName")}</Text>
        </View>
        {validationHint !== null && (
          <Text className="text-sm text-danger" testID="pay-address-hint">
            {validationHint}
          </Text>
        )}
        {error !== null && (
          <Text className="text-sm text-danger" testID="pay-address-error">
            {error}
          </Text>
        )}
        <Button
          label={busy ? t("payPaying") : t("paySend")}
          variant="primary"
          disabled={invalid}
          onPress={() => void pay()}
          testID="pay-address-pay"
        />
      </Surface>
    </ScrollView>
  );
}
