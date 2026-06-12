/**
 * Token detail (#38; `cashu.token-detail` / `cashu.share-token` /
 * `cashu.validate-token` / `cashu.reserve-token` / `cashu.return-token`).
 *
 * PoC parity (CashuTokenPage): amount headline (shared Amount — masking
 * applies), mint note, state hints, QR of the raw token (the raw string
 * stays behind the QR / copy — never rendered as text), copy, share via
 * the public Linky link (fragment format — the token never reaches a
 * server), check (NUT-07 → reconcile), the #33 repair actions per state
 * (reserve / return / re-accept) and delete with the PoC's two-tap arm.
 */
import { Amount, Button, Surface, Text } from "@linky/ui";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, ScrollView, Share, View } from "react-native";

import { QrCode } from "../../../src/components/QrCode";
import { useLocale } from "../../../src/locales";
import { buildTokenTagUrl } from "../../../src/nfc/nfcPayload";
import { cancelNfcSession, writeNfcTagUri } from "../../../src/nfc/nfcSession";
import { useNfcSupported } from "../../../src/nfc/nfcSupport";
import { useEffectQuery } from "../../../src/runtime";
import { useSession } from "../../../src/session/useSession";
import { copyToClipboard } from "../../../src/settings/nostrKeyActions";
import { getStoreDataVersion, subscribeToStoreData } from "../../../src/store/storeManager";
import { useLinkyStore } from "../../../src/store/useLinkyStore";
import { toast } from "../../../src/toast";
import { useAmountDisplay } from "../../../src/wallet/AmountDisplayProvider";
import {
  checkToken,
  deleteToken,
  externalizeToken,
  loadTokenDetail,
  reacceptToken,
  reserveToken,
  returnTokenToWallet,
} from "../../../src/wallet/tokenActions";
import {
  mintDisplayName,
  tokenDetailActions,
  tokenShareUrl,
  tokenStateLabelKey,
  tokenStateTone,
} from "../../../src/wallet/tokenListModel";

export default function TokenDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, locale } = useLocale();
  const router = useRouter();
  const { unit, hidden } = useAmountDisplay();

  const storeState = useLinkyStore();
  const store = storeState.status === "ready" ? storeState.store : null;
  const session = useSession();
  const seed =
    session.status === "success" && session.data._tag === "IdentityLoaded"
      ? session.data.session.cashuWallet.seed
      : null;

  const dataVersion = useSyncExternalStore(subscribeToStoreData, getStoreDataVersion);
  const detail = useEffectQuery(loadTokenDetail(id ?? ""), [id, dataVersion]);

  const [busy, setBusy] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);

  /** `cashu.write-nfc` (#50): gated on device support, like every NFC UI. */
  const nfcSupported = useNfcSupported();
  const [nfcWriting, setNfcWriting] = useState(false);

  const record = detail.status === "success" ? detail.data : null;

  // PoC parity: when the row vanishes after we had it once (cleanup,
  // delete elsewhere), bounce back to the list instead of an error panel.
  const hadRecordRef = useRef(false);
  if (record !== null) hadRecordRef.current = true;
  useEffect(() => {
    if (detail.status === "success" && record === null && hadRecordRef.current) {
      router.back();
    }
  }, [detail.status, record, router]);

  if (record === null) {
    return (
      <>
        <Stack.Screen options={{ title: t("cashuToken") }} />
        <View className="flex-1 bg-background px-6 pt-4">
          <Surface>
            <Text className="opacity-70">…</Text>
          </Surface>
        </View>
      </>
    );
  }

  const actions = tokenDetailActions(record.state);
  const shareUrl = tokenShareUrl(record.token);
  const tone = tokenStateTone(record.state);

  const copyTokenText = () => {
    void copyToClipboard(record.token).then((ok) => {
      if (ok) toast.success(t("copiedToClipboard"));
      else toast.error(t("copyFailed"));
    });
  };

  const copyShareLink = () => {
    if (shareUrl === null) return;
    void copyToClipboard(shareUrl).then((ok) => {
      if (ok) toast.success(t("copiedToClipboard"));
      else toast.error(t("copyFailed"));
    });
  };

  const shareLink = () => {
    if (shareUrl === null) return;
    void Share.share({
      message: t("cashuShareMessageWithAmount", {
        amount: `${record.amount} sat`,
        url: shareUrl,
      }),
    }).catch(() => toast.error(t("copyFailed")));
  };

  const runCheck = async () => {
    if (store === null || busy) return;
    setBusy(true);
    try {
      const outcome = await checkToken(store, record.id);
      switch (outcome) {
        case "ok":
          toast.success(t("cashuCheckOk"));
          break;
        case "spent":
        case "invalid":
          toast.error(t("cashuInvalid"));
          break;
        case "unknown":
          toast.info(t("cashuCheckUnknown"));
          break;
        case "failed":
          toast.error(t("cashuCheckFailed"));
          break;
      }
    } finally {
      setBusy(false);
    }
  };

  const runReserve = async () => {
    if (store === null || busy) return;
    setBusy(true);
    try {
      const ok = await reserveToken(store, record.id);
      if (ok) toast.success(t("cashuReserved"));
    } finally {
      setBusy(false);
    }
  };

  const runReturn = async () => {
    if (store === null || busy) return;
    setBusy(true);
    try {
      const ok = await returnTokenToWallet(store, record.id);
      if (ok) toast.success(t("cashuReturnedToWallet"));
    } finally {
      setBusy(false);
    }
  };

  const runReaccept = async () => {
    if (store === null || seed === null || busy) return;
    setBusy(true);
    try {
      const outcome = await reacceptToken(store, seed, record.id);
      switch (outcome.kind) {
        case "recovered":
          toast.success(t("cashuReaccepted"));
          break;
        case "spent":
          toast.error(t("cashuInvalid"));
          break;
        case "failed":
          toast.error(t("cashuReacceptFailed"));
          break;
      }
    } finally {
      setBusy(false);
    }
  };

  /**
   * `cashu.write-nfc` + `cashu.externalize-token` (#50). Ordering is the
   * PoC's (`writeCashuTokenToNfc`), and it is the fund-safe direction: the
   * row is externalized ONLY after the tag write is CONFIRMED — a failed/
   * cancelled write leaves the token exactly as it was. (The write puts the
   * linky.fit share URL on the tag — see nfcPayload.ts for the deliberate
   * PoC divergence from `cashu://`.) Should the local state write fail
   * after a confirmed tag write (concurrent state change), the row keeps
   * its old state: same proofs, first redeemer wins — bookkeeping only,
   * the user can retry or Reserve manually.
   */
  const runWriteNfc = async () => {
    if (store === null || busy || nfcWriting) return;
    const url = buildTokenTagUrl(record.token);
    if (url === null) {
      toast.error(t("cashuInvalid"));
      return;
    }
    setNfcWriting(true);
    try {
      const outcome = await writeNfcTagUri(url, {
        prompt: t("nfcWriteTapPrompt"),
        success: t("nfcWriteTokenSuccess"),
      });
      switch (outcome.kind) {
        case "written": {
          const ok = await externalizeToken(store, record.id);
          if (ok) toast.success(t("nfcWriteTokenSuccess"));
          else toast.error(`${t("errorPrefix")}: IllegalTokenStateTransitionError`);
          return;
        }
        case "cancelled":
          return;
        case "busy":
          toast.error(t("nfcWriteBusy"));
          return;
        case "disabled":
          toast.error(t("nfcWriteDisabled"));
          return;
        case "unavailable":
          toast.error(t("nfcWriteUnsupported"));
          return;
        case "failed":
          toast.error(
            outcome.message === null
              ? t("nfcWriteFailed")
              : `${t("nfcWriteFailed")}: ${outcome.message}`,
          );
          return;
      }
    } finally {
      setNfcWriting(false);
    }
  };

  const runDelete = async () => {
    if (store === null || busy) return;
    // PoC two-tap arm: first tap arms the button, second deletes.
    if (!deleteArmed) {
      setDeleteArmed(true);
      toast.info(t("deleteArmedHint"));
      return;
    }
    setBusy(true);
    try {
      const ok = await deleteToken(store, record.id);
      if (ok) {
        toast.success(t("cashuDeleted"));
        router.back();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Stack.Screen options={{ title: t("cashuToken") }} />
      <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 px-6 pb-8 pt-4">
        {/* Amount + mint + state badge. */}
        <View className="items-center gap-1 py-2">
          <Amount amount={record.amount} unit={unit} hidden={hidden} locale={locale} size="hero" />
          <Text className="text-sm opacity-70" testID="token-detail-mint">
            Mint: {mintDisplayName(record.mintUrl)}
          </Text>
          <View
            className={`mt-1 rounded-full px-3 py-1 ${tone === "danger" ? "bg-danger/15" : "bg-surface"}`}
            testID="token-detail-state"
          >
            <Text className={`text-xs ${tone === "danger" ? "text-danger" : "opacity-70"}`}>
              {t(tokenStateLabelKey(record.state))}
            </Text>
          </View>
        </View>

        {/* State hints (PoC copy). */}
        {record.state === "error" && (
          <Surface className="border-l-4 border-l-danger">
            <Text className="text-sm text-danger" testID="token-detail-error">
              {(record.error ?? "").trim() || t("cashuInvalid")}
            </Text>
          </Surface>
        )}
        {record.state === "externalized" && (
          <Text className="text-center text-sm opacity-70">{t("cashuOnNfc")}</Text>
        )}
        {record.state === "pending" && (
          <Text className="text-center text-sm opacity-70">{t("cashuPendingHint")}</Text>
        )}
        {record.state === "reserved" && (
          <Text className="text-center text-sm opacity-70">{t("cashuReservedHint")}</Text>
        )}

        {/* Raw token: QR + copy only — never rendered as text. */}
        <Pressable accessibilityRole="button" onPress={copyTokenText} testID="token-detail-qr">
          <QrCode value={record.token} size={240} />
        </Pressable>

        <View className="gap-3">
          <Button
            label={t("copy")}
            variant="secondary"
            onPress={copyTokenText}
            testID="token-detail-copy"
          />
          <Button
            label={t("cashuCopyShareLink")}
            variant="secondary"
            disabled={shareUrl === null}
            onPress={copyShareLink}
            testID="token-detail-copy-link"
          />
          <Button
            label={t("share")}
            variant="secondary"
            disabled={shareUrl === null}
            onPress={shareLink}
            testID="token-detail-share"
          />
          {/* cashu.write-nfc: NFC-capable devices + Externalize-legal states only. */}
          {nfcSupported && actions.canWriteNfc && (
            <Button
              label={t("uploadToNfc")}
              variant="secondary"
              disabled={busy || nfcWriting || store === null || shareUrl === null}
              onPress={() => void runWriteNfc()}
              testID="token-detail-write-nfc"
            />
          )}
          {/* iOS shows the system NFC sheet; Android writes silently, so
              this inline prompt (with cancel) is its UI. */}
          {nfcWriting && (
            <Surface className="gap-3" testID="token-detail-nfc-pending">
              <Text className="text-sm opacity-70">{t("nfcWriteTapPrompt")}</Text>
              <Button label={t("cancel")} variant="secondary" onPress={() => cancelNfcSession()} />
            </Surface>
          )}

          {actions.canCheck && (
            <Button
              label={busy ? t("cashuChecking") : t("cashuCheckToken")}
              variant="primary"
              disabled={busy || store === null}
              onPress={() => void runCheck()}
              testID="token-detail-check"
            />
          )}
          {actions.canReaccept && (
            <Button
              label={t("cashuReaccept")}
              variant="primary"
              disabled={busy || store === null || seed === null}
              onPress={() => void runReaccept()}
              testID="token-detail-reaccept"
            />
          )}
          {actions.canReserve && (
            <Button
              label={t("cashuMarkReserved")}
              variant="secondary"
              disabled={busy || store === null}
              onPress={() => void runReserve()}
              testID="token-detail-reserve"
            />
          )}
          {actions.canReturn && (
            <Button
              label={t("cashuReturnToWallet")}
              variant="secondary"
              disabled={busy || store === null}
              onPress={() => void runReturn()}
              testID="token-detail-return"
            />
          )}

          <Button
            label={t("delete")}
            variant={deleteArmed ? "danger" : "secondary"}
            disabled={busy || store === null}
            onPress={() => void runDelete()}
            testID="token-detail-delete"
          />
        </View>
      </ScrollView>
    </>
  );
}
