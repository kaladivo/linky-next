/**
 * Transaction history list (#43; `tx.list` / `tx.link-contact` /
 * `tx.link-mint` / `tx.request-status` / `tx.merge-issued-token-spend`).
 *
 * PoC parity (TransactionsPage): newest-first payment history, separate
 * from the token list — titles resolve contact > note > flow label, rows
 * carry the date, a pending/failed/request-status pill and the signed
 * amount (shared Amount component — masking applies). Issued-then-spent
 * pairs and fulfilled requests render as ONE item (model merge). Tap
 * pushes the detail screen (the PoC expanded inline; mobile follows the
 * token-list push convention).
 */
import { Amount, Surface, Text } from "@linky/ui";
import { useRouter } from "expo-router";
import { useSyncExternalStore } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { useLocale } from "../../src/locales";
import { useEffectQuery } from "../../src/runtime";
import { getStoreDataVersion, subscribeToStoreData } from "../../src/store/storeManager";
import { useAmountDisplay } from "../../src/wallet/AmountDisplayProvider";
import { mintDisplayName } from "../../src/wallet/tokenListModel";
import { contactDisplayLabel, loadTransactionHistory } from "../../src/wallet/transactionsData";
import type { TransactionHistoryView } from "../../src/wallet/transactionsData";
import {
  formatTransactionDate,
  transactionStatusPill,
  transactionTitle,
} from "../../src/wallet/transactionsModel";
import type { HistoryItem, TransactionPillTone } from "../../src/wallet/transactionsModel";

const pillToneClassName: Record<TransactionPillTone, string> = {
  ok: "bg-primary/15",
  muted: "bg-background",
  danger: "bg-danger/15",
};

const pillLabelClassName: Record<TransactionPillTone, string> = {
  ok: "text-primary",
  muted: "text-foreground opacity-70",
  danger: "text-danger",
};

function TransactionAmount({ item }: { readonly item: HistoryItem }) {
  const { locale } = useLocale();
  const { unit, hidden } = useAmountDisplay();
  const { amount, unit: rowUnit, direction } = item.record;
  if (amount === null) return null;
  const sign = direction === "in" ? "+" : "−";
  return (
    <View className="flex-row items-baseline gap-1">
      <Text weight="semibold" className={direction === "in" ? "text-primary" : "opacity-70"}>
        {sign}
      </Text>
      {rowUnit !== null && rowUnit !== "sat" ? (
        // Non-sat units render raw (PoC parity) — Amount is sat-based.
        <Text weight="semibold">{`${amount} ${rowUnit}`}</Text>
      ) : (
        <Amount amount={amount} unit={unit} hidden={hidden} locale={locale} />
      )}
    </View>
  );
}

function TransactionRow({
  item,
  view,
}: {
  readonly item: HistoryItem;
  readonly view: TransactionHistoryView;
}) {
  const { t, locale } = useLocale();
  const router = useRouter();
  const { record } = item;

  const contact =
    record.contactId === null ? null : (view.contactsById.get(record.contactId) ?? null);
  const title = transactionTitle(item, contactDisplayLabel(contact));
  const pill = transactionStatusPill(item);

  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push(`/wallet/transaction/${record.id}`)}
      testID={`transaction-row-${record.id}`}
      className="flex-row items-center gap-3 rounded-xl bg-surface px-4 py-3 active:opacity-80"
    >
      <View className="flex-1 gap-0.5">
        <Text numberOfLines={1}>{title.kind === "key" ? t(title.key) : title.text}</Text>
        <View className="flex-row items-center gap-2">
          <Text className="text-xs opacity-60">
            {formatTransactionDate(locale, record.happenedAtSec)}
          </Text>
          {pill !== null && (
            <View className={`rounded-full px-2 py-0.5 ${pillToneClassName[pill.tone]}`}>
              <Text className={`text-xs ${pillLabelClassName[pill.tone]}`}>{t(pill.labelKey)}</Text>
            </View>
          )}
        </View>
        {record.mintUrl !== null && (
          <Text className="text-xs opacity-60" numberOfLines={1}>
            {mintDisplayName(record.mintUrl)}
          </Text>
        )}
      </View>
      <TransactionAmount item={item} />
    </Pressable>
  );
}

export default function WalletTransactionsScreen() {
  const { t } = useLocale();
  const dataVersion = useSyncExternalStore(subscribeToStoreData, getStoreDataVersion);
  const history = useEffectQuery(loadTransactionHistory, [dataVersion]);

  const view = history.status === "success" ? history.data : null;

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-2 px-6 pb-8 pt-4">
      {view === null ? (
        <Surface>
          <Text className="opacity-70">…</Text>
        </Surface>
      ) : view.items.length === 0 ? (
        <Surface testID="transactions-empty">
          <Text className="opacity-70">{t("paymentsHistoryEmpty")}</Text>
        </Surface>
      ) : (
        <View className="gap-2" testID="transactions-list">
          {view.items.map((item) => (
            <TransactionRow key={item.record.id} item={item} view={view} />
          ))}
        </View>
      )}
    </ScrollView>
  );
}
