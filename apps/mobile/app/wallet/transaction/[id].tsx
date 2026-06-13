/**
 * Transaction detail (#43; `tx.details` / `tx.link-contact` /
 * `tx.link-mint`).
 *
 * Header: signed amount (shared Amount — masking applies), title, date,
 * status pill, fee. Linked rows push the contact / mint detail screens.
 * Below: the user-facing fields, then the collapsed "Support details"
 * section — every support row copies on tap and a button copies the whole
 * support dump (whitelisted JSON; never tokens/proofs/keys — split per the
 * #59 decision documented in transactionsModel.ts).
 */
import { Amount, Button, Surface, Text } from "@linky/ui";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useState, useSyncExternalStore } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { useLocale } from "../../../src/locales";
import { useEffectQuery } from "../../../src/runtime";
import { copyToClipboard } from "../../../src/settings/nostrKeyActions";
import { getStoreDataVersion, subscribeToStoreData } from "../../../src/store/storeManager";
import { toast } from "../../../src/toast";
import { useAmountDisplay } from "../../../src/wallet/AmountDisplayProvider";
import { mintDisplayName } from "../../../src/wallet/tokenListModel";
import { contactDisplayLabel, loadTransactionDetail } from "../../../src/wallet/transactionsData";
import {
  buildSupportDump,
  formatTransactionDate,
  transactionDetailSections,
  transactionStatusLabelKey,
  transactionStatusPill,
  transactionTitle,
} from "../../../src/wallet/transactionsModel";
import type {
  TransactionDetailField,
  TransactionPillTone,
} from "../../../src/wallet/transactionsModel";

const pillToneClassName: Record<TransactionPillTone, string> = {
  ok: "bg-primary/15",
  muted: "bg-surface",
  danger: "bg-danger/15",
};

const pillLabelClassName: Record<TransactionPillTone, string> = {
  ok: "text-primary",
  muted: "text-foreground opacity-70",
  danger: "text-danger",
};

/** A label/value row; tapping copies `copyValue ?? value`. */
function CopyRow({ field: entry }: { readonly field: TransactionDetailField }) {
  const { t } = useLocale();
  const copy = () => {
    void copyToClipboard(entry.copyValue ?? entry.value).then((ok) => {
      if (ok) toast.success(t("copiedToClipboard"));
      else toast.error(t("copyFailed"));
    });
  };
  return (
    <Pressable
      accessibilityRole="button"
      onPress={copy}
      className="gap-0.5 active:opacity-70"
      testID={`transaction-detail-${entry.labelKey}`}
    >
      <Text className="text-xs opacity-60">{t(entry.labelKey)}</Text>
      <Text className="text-sm">{entry.value}</Text>
    </Pressable>
  );
}

export default function TransactionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, locale } = useLocale();
  const router = useRouter();
  const { unit, hidden } = useAmountDisplay();

  const dataVersion = useSyncExternalStore(subscribeToStoreData, getStoreDataVersion);
  const detail = useEffectQuery(loadTransactionDetail(id ?? ""), [id, dataVersion]);
  const [supportOpen, setSupportOpen] = useState(false);

  const view = detail.status === "success" ? detail.data : null;

  if (view === null) {
    return (
      <>
        <Stack.Screen options={{ title: t("transactionDetailTitle") }} />
        <View className="flex-1 bg-background px-6 pt-4">
          <Surface>
            <Text className="opacity-70">
              {detail.status === "success" ? t("paymentsHistoryEmpty") : "…"}
            </Text>
          </Surface>
        </View>
      </>
    );
  }

  const { item, contact, mint } = view;
  const { record } = item;
  const title = transactionTitle(item, contactDisplayLabel(contact));
  const pill = transactionStatusPill(item);
  const statusKey = transactionStatusLabelKey(record.status);
  const sections = transactionDetailSections(item);
  const sign = record.direction === "in" ? "+" : "−";

  const copySupportDump = () => {
    void copyToClipboard(buildSupportDump(item)).then((ok) => {
      if (ok) toast.success(t("copiedToClipboard"));
      else toast.error(t("copyFailed"));
    });
  };

  return (
    <>
      <Stack.Screen options={{ title: t("transactionDetailTitle") }} />
      <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 px-6 pb-8 pt-4">
        {/* Headline: signed amount + title + date + status. */}
        <View className="items-center gap-1 py-2">
          {record.amount !== null && (
            <View className="flex-row items-baseline gap-2">
              <Text
                weight="bold"
                className={`text-3xl ${record.direction === "in" ? "text-primary" : "opacity-70"}`}
              >
                {sign}
              </Text>
              {record.unit !== null && record.unit !== "sat" ? (
                <Text weight="bold" className="text-5xl leading-[56px]">
                  {`${record.amount} ${record.unit}`}
                </Text>
              ) : (
                <Amount
                  amount={record.amount}
                  unit={unit}
                  hidden={hidden}
                  locale={locale}
                  size="hero"
                />
              )}
            </View>
          )}
          <Text className="text-sm" testID="transaction-detail-title">
            {title.kind === "key" ? t(title.key) : title.text}
          </Text>
          <Text className="text-sm opacity-70">
            {formatTransactionDate(locale, record.happenedAtSec)}
          </Text>
          <View
            className={`mt-1 rounded-full px-3 py-1 ${pill === null ? "bg-surface" : pillToneClassName[pill.tone]}`}
            testID="transaction-detail-status"
          >
            <Text
              className={`text-xs ${pill === null ? "opacity-70" : pillLabelClassName[pill.tone]}`}
            >
              {pill !== null ? t(pill.labelKey) : statusKey !== null ? t(statusKey) : record.status}
            </Text>
          </View>
        </View>

        {/* Linked context: contact, mint, fee. */}
        <Surface className="gap-3">
          {contact !== null && (
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push(`/contact/${contact.id}`)}
              className="flex-row items-baseline justify-between gap-3 active:opacity-70"
              testID="transaction-detail-contact"
            >
              <Text className="text-xs opacity-60">{t("transactionDetailContact")}</Text>
              <Text className="shrink text-sm text-primary" numberOfLines={1}>
                {contactDisplayLabel(contact) ?? contact.id}
              </Text>
            </Pressable>
          )}
          {record.mintUrl !== null &&
            (mint !== null ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => router.push(`/wallet/mint/${encodeURIComponent(mint.url)}`)}
                className="flex-row items-baseline justify-between gap-3 active:opacity-70"
                testID="transaction-detail-mint"
              >
                <Text className="text-xs opacity-60">{t("transactionDetailMint")}</Text>
                <Text className="shrink text-sm text-primary" numberOfLines={1}>
                  {mint.name ?? mintDisplayName(mint.url)}
                </Text>
              </Pressable>
            ) : (
              <View className="flex-row items-baseline justify-between gap-3">
                <Text className="text-xs opacity-60">{t("transactionDetailMint")}</Text>
                <Text className="shrink text-sm" numberOfLines={1}>
                  {mintDisplayName(record.mintUrl)}
                </Text>
              </View>
            ))}
          {record.feeAmount !== null && record.feeAmount > 0 && (
            <View className="flex-row items-baseline justify-between gap-3">
              <Text className="text-xs opacity-60">{t("paymentsHistoryFee")}</Text>
              <Text className="text-sm">{`${record.feeAmount} ${record.unit ?? "sat"}`}</Text>
            </View>
          )}
        </Surface>

        {/* User-facing fields (error, request text, memos, LNURL messages). */}
        {sections.user.length > 0 && (
          <Surface className="gap-3" testID="transaction-detail-user-fields">
            {sections.user.map((entry) => (
              <CopyRow key={entry.labelKey} field={entry} />
            ))}
          </Surface>
        )}

        {/* Support-only section (`tx.details`, split #59). */}
        <Surface className="gap-3" testID="transaction-detail-support">
          <Pressable
            accessibilityRole="button"
            onPress={() => setSupportOpen((open) => !open)}
            className="flex-row items-center justify-between active:opacity-70"
            testID="transaction-detail-support-toggle"
          >
            <Text weight="semibold">{t("transactionSupportSection")}</Text>
            <Text className="opacity-60">{supportOpen ? "▾" : "▸"}</Text>
          </Pressable>
          {supportOpen && (
            <>
              <Text className="text-xs opacity-60">{t("transactionSupportHint")}</Text>
              {sections.support.map((entry) => (
                <CopyRow key={entry.labelKey} field={entry} />
              ))}
              <Button
                label={t("transactionCopySupportDetails")}
                variant="secondary"
                onPress={copySupportDump}
                testID="transaction-detail-copy-support"
              />
            </>
          )}
        </Surface>
      </ScrollView>
    </>
  );
}
