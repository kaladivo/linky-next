/**
 * LNURL-withdraw (#40; `lnurl.withdraw`): manual target entry (scanner is
 * #48), offer preview, confirm, then wait for the service's payment to
 * settle into the wallet — success via paid overlay, errors inline.
 *
 * PoC parity (LnurlWithdrawConfirmModal + confirmLnurlWithdraw): the
 * preview shows the maximum withdrawable as the amount, `description ??
 * target` as the summary, the "maximum available amount" note for ranged
 * offers, and the confirm button is labeled "Receive".
 */
import { Amount, Button, Surface, Text } from "@linky/ui";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ScrollView, TextInput, View } from "react-native";

import { useLocale } from "../../src/locales";
import { paidOverlay } from "../../src/paidOverlay";
import { useSession } from "../../src/session/useSession";
import { readClipboardText } from "../../src/settings/nostrKeyActions";
import { useLinkyStore } from "../../src/store/useLinkyStore";
import { toast } from "../../src/toast";
import { useAmountDisplay } from "../../src/wallet/AmountDisplayProvider";
import {
  hasVariableWithdrawAmount,
  withdrawConfirmErrorKey,
  withdrawErrorText,
  withdrawOfferErrorKey,
  withdrawOfferSummary,
} from "../../src/wallet/lnurlWithdrawModel";
import { useLnurlWithdraw } from "../../src/wallet/useLnurlWithdraw";

export default function LnurlWithdrawScreen() {
  const { t, locale } = useLocale();
  const router = useRouter();
  const { unit, hidden } = useAmountDisplay();
  const { target: targetParam } = useLocalSearchParams<{ target?: string }>();

  const storeState = useLinkyStore();
  const store = storeState.status === "ready" ? storeState.store : null;
  const session = useSession();
  const seed =
    session.status === "success" && session.data._tag === "IdentityLoaded"
      ? session.data.session.cashuWallet.seed
      : null;

  const [inputText, setInputText] = useState("");
  const [target, setTarget] = useState<string | null>(() => {
    const initial = typeof targetParam === "string" ? targetParam.trim() : "";
    return initial === "" ? null : initial;
  });

  const { state, confirm, retryLoad, retryClaim } = useLnurlWithdraw(store, seed, target);

  // Success feedback exactly once: paid overlay + pop back to the wallet
  // (the receive-invoice convention).
  const settledRef = useRef(false);
  useEffect(() => {
    if (settledRef.current || state.status !== "claimed") return;
    settledRef.current = true;
    paidOverlay.show();
    router.dismissAll();
  }, [state.status, router]);

  // Failures also toast (visible even mid-scroll); inline copy below.
  useEffect(() => {
    if (state.status === "claim-failed") toast.error(t("topupClaimFailed"));
    if (state.status === "expired") toast.error(t("topupQuoteExpired"));
  }, [state.status, t]);

  const pasteFromClipboard = () => {
    void readClipboardText().then((text) => {
      if (text === null || text.trim() === "") toast.error(t("pasteEmpty"));
      else setInputText(text.trim());
    });
  };

  const offer = state.status === "offer" || state.status === "waiting" ? state.offer : null;

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 px-6 pb-8 pt-4">
      {/* Manual entry (scanner lands with #48). */}
      {state.status === "idle" && (
        <Surface className="gap-3">
          <Text className="text-sm opacity-70">{t("lnurlWithdrawInputPrompt")}</Text>
          <TextInput
            value={inputText}
            onChangeText={setInputText}
            placeholder="lnurl1… / lnurlw://…"
            placeholderTextColor="#94a3b8"
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            testID="lnurl-withdraw-input"
            className="min-h-20 rounded-xl bg-background px-4 py-3 font-sans text-foreground"
          />
          <Button
            label={t("paste")}
            variant="secondary"
            onPress={pasteFromClipboard}
            testID="lnurl-withdraw-paste"
          />
          <Button
            label={t("lnurlWithdrawLoad")}
            variant="primary"
            disabled={inputText.trim() === ""}
            onPress={() => setTarget(inputText.trim())}
            testID="lnurl-withdraw-load"
          />
        </Surface>
      )}

      {state.status === "loading" && (
        <Surface>
          <Text className="opacity-70">{t("lnurlWithdrawLoading")}</Text>
        </Surface>
      )}

      {state.status === "load-failed" && (
        <Surface className="gap-3" testID="lnurl-withdraw-load-failed">
          <Text className="text-danger">
            {withdrawErrorText(t(withdrawOfferErrorKey(state.errorTag)), state.reason)}
          </Text>
          <Button label={t("onboardingRetry")} variant="primary" onPress={retryLoad} />
          <Button
            label={t("cancel")}
            variant="secondary"
            onPress={() => setTarget(null)}
            testID="lnurl-withdraw-edit"
          />
        </Surface>
      )}

      {/* Offer preview / waiting share the amount headline (PoC modal). */}
      {offer !== null && (
        <View className="items-center gap-1 py-2">
          <Amount
            amount={offer.defaultAmountSat}
            unit={unit}
            hidden={hidden}
            locale={locale}
            size="hero"
          />
          <Text className="text-sm opacity-70" testID="lnurl-withdraw-summary">
            {withdrawOfferSummary(offer)}
          </Text>
          {hasVariableWithdrawAmount(offer) && (
            <Text className="text-center text-sm opacity-70" testID="lnurl-withdraw-variable">
              {t("lnurlWithdrawVariableAmount")}
            </Text>
          )}
        </View>
      )}

      {state.status === "offer" && (
        <View className="gap-4">
          {state.confirmErrorTag !== null && (
            <Surface testID="lnurl-withdraw-confirm-error">
              <Text className="text-danger">
                {withdrawErrorText(
                  t(withdrawConfirmErrorKey(state.confirmErrorTag)),
                  state.confirmErrorReason,
                )}
              </Text>
            </Surface>
          )}
          {state.confirming && (
            <Text className="text-center text-sm opacity-70">{t("lnurlWithdrawPreparing")}</Text>
          )}
          <Button
            label={t("walletReceive")}
            variant="primary"
            disabled={state.confirming || store === null}
            onPress={confirm}
            testID="lnurl-withdraw-confirm"
          />
          <Button
            label={t("payCancel")}
            variant="secondary"
            disabled={state.confirming}
            onPress={() => router.back()}
            testID="lnurl-withdraw-cancel"
          />
        </View>
      )}

      {state.status === "waiting" && (
        <Surface>
          <Text className="text-center text-sm opacity-70" testID="lnurl-withdraw-status">
            {state.claiming ? t("topupClaiming") : t("lnurlWithdrawPending")}
          </Text>
        </Surface>
      )}

      {state.status === "expired" && (
        <Surface className="gap-3">
          <Text className="text-danger">{t("topupQuoteExpired")}</Text>
        </Surface>
      )}

      {state.status === "claim-failed" && (
        <Surface className="gap-3" testID="lnurl-withdraw-claim-failed">
          <Text className="text-danger">{t("topupClaimFailed")}</Text>
          <Button label={t("onboardingRetry")} variant="primary" onPress={retryClaim} />
        </Surface>
      )}
    </ScrollView>
  );
}
