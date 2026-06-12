/**
 * Token list (#38; `cashu.validate-token` / `cashu.cleanup-spent` /
 * `cashu.restore-tokens` entry points).
 *
 * PoC parity (CashuTokensPage): two sections — "mine" (held value) and
 * "issued" (value that is out: issued/pending/externalized/reserved) —
 * with per-section totals, plus the bulk actions: cleanup spent
 * (check → reconcile → purge, counts reported via toast) and deterministic
 * restore. Rows show amount (shared Amount component — masking applies),
 * mint host and a state badge; tap pushes the token detail.
 */
import type { TokenRecord } from "@linky/core";
import { Amount, Button, Surface, Text } from "@linky/ui";
import { useRouter } from "expo-router";
import { useState, useSyncExternalStore } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { useLocale } from "../../src/locales";
import { useEffectQuery } from "../../src/runtime";
import { useSession } from "../../src/session/useSession";
import { getStoreDataVersion, subscribeToStoreData } from "../../src/store/storeManager";
import { useLinkyStore } from "../../src/store/useLinkyStore";
import { toast } from "../../src/toast";
import { useAmountDisplay } from "../../src/wallet/AmountDisplayProvider";
import {
  loadMeltToMainAvailabilityData,
  meltLargestToMainFromScreens,
} from "../../src/wallet/consolidationActions";
import { cleanupSpentTokens, loadTokenList, restoreWalletTokens } from "../../src/wallet/tokenActions";
import {
  mintDisplayName,
  tokenStateLabelKey,
  tokenStateTone,
} from "../../src/wallet/tokenListModel";
import type { TokenStateTone } from "../../src/wallet/tokenListModel";

const badgeToneClassName: Record<TokenStateTone, string> = {
  ok: "bg-primary/15",
  muted: "bg-surface",
  danger: "bg-danger/15",
};

const badgeLabelClassName: Record<TokenStateTone, string> = {
  ok: "text-primary",
  muted: "text-foreground opacity-70",
  danger: "text-danger",
};

function TokenRow({ record }: { readonly record: TokenRecord }) {
  const { t, locale } = useLocale();
  const router = useRouter();
  const { unit, hidden } = useAmountDisplay();
  const tone = tokenStateTone(record.state);

  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push(`/wallet/token/${record.id}`)}
      testID={`token-row-${record.id}`}
      className="flex-row items-center gap-3 rounded-xl bg-surface px-4 py-3 active:opacity-80"
    >
      <View className="flex-1 gap-0.5">
        <Amount amount={record.amount} unit={unit} hidden={hidden} locale={locale} />
        <Text className="text-xs opacity-60" numberOfLines={1}>
          {mintDisplayName(record.mintUrl)}
        </Text>
      </View>
      <View className={`rounded-full px-3 py-1 ${badgeToneClassName[tone]}`}>
        <Text className={`text-xs ${badgeLabelClassName[tone]}`}>
          {t(tokenStateLabelKey(record.state))}
        </Text>
      </View>
    </Pressable>
  );
}

export default function WalletTokensScreen() {
  const { t, locale } = useLocale();
  const { unit, hidden } = useAmountDisplay();

  const storeState = useLinkyStore();
  const store = storeState.status === "ready" ? storeState.store : null;
  const session = useSession();
  const seed =
    session.status === "success" && session.data._tag === "IdentityLoaded"
      ? session.data.session.cashuWallet.seed
      : null;

  const dataVersion = useSyncExternalStore(subscribeToStoreData, getStoreDataVersion);
  const list = useEffectQuery(loadTokenList, [dataVersion]);
  const meltAvailability = useEffectQuery(loadMeltToMainAvailabilityData, [dataVersion]);

  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [meltBusy, setMeltBusy] = useState(false);
  const busy = cleanupBusy || restoreBusy || meltBusy;

  const runCleanup = async () => {
    if (store === null || busy) return;
    setCleanupBusy(true);
    try {
      const outcome = await cleanupSpentTokens(store);
      toast.success(
        t("cashuCleanupDone", {
          checked: outcome.checked,
          spent: outcome.spent,
          purged: outcome.purged,
        }),
      );
      if (outcome.failedMints > 0) toast.error(t("cashuCleanupMintFailed"));
    } catch {
      toast.error(t("cashuCheckFailed"));
    } finally {
      setCleanupBusy(false);
    }
  };

  const runRestore = async () => {
    if (store === null || seed === null || busy) return;
    setRestoreBusy(true);
    try {
      const outcome = await restoreWalletTokens(store, seed);
      if (outcome.restoredAmount > 0) {
        toast.success(t("restoreDoneAmount", { amount: outcome.restoredAmount }));
      } else if (outcome.failedMints === 0) {
        toast.info(t("restoreNothing"));
      }
      if (outcome.failedMints > 0) toast.error(t("restoreFailed"));
    } catch {
      toast.error(t("restoreFailed"));
    } finally {
      setRestoreBusy(false);
    }
  };

  // `mints.melt-to-main` (#42): manual consolidation of the largest
  // foreign-mint balance toward the main mint (PoC token-list button).
  const meltTarget = meltAvailability.status === "success" ? meltAvailability.data : null;

  const runMeltToMain = async () => {
    if (seed === null || busy || meltTarget === null) return;
    setMeltBusy(true);
    toast.info(t("cashuMeltToMainMintProcessing"));
    try {
      const outcome = await meltLargestToMainFromScreens(seed);
      if (outcome.kind === "consolidated") {
        toast.success(
          t("cashuMeltToMainMintDone", {
            amount: outcome.amountSat,
            unit: "sat",
            mint: meltTarget.targetDisplayName,
          }),
        );
      } else if (outcome.kind === "pending-claim") {
        toast.info(t("cashuMeltToMainMintPending", { amount: outcome.amountSat, unit: "sat" }));
      } else if (outcome.kind === "nothing") {
        toast.info(t("cashuMeltToMainMintUnavailable"));
      } else {
        toast.error(`${t("cashuMeltToMainMintFailed")}: ${outcome.reason}`);
      }
    } catch {
      toast.error(t("cashuMeltToMainMintFailed"));
    } finally {
      setMeltBusy(false);
    }
  };

  const groups = list.status === "success" ? list.data : null;

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 px-6 pb-8 pt-4">
      {groups === null ? (
        <Surface>
          <Text className="opacity-70">…</Text>
        </Surface>
      ) : (
        <>
          {/* Held tokens + bulk actions (PoC "mine" section). */}
          <View className="gap-2">
            <View className="flex-row items-baseline justify-between">
              <Text weight="semibold">{t("cashuMine")}</Text>
              <Amount amount={groups.mineTotal} unit={unit} hidden={hidden} locale={locale} />
            </View>
            {groups.mine.length === 0 ? (
              <Surface>
                <Text className="opacity-70">{t("cashuEmpty")}</Text>
              </Surface>
            ) : (
              <View className="gap-2" testID="token-list-mine">
                {groups.mine.map((record) => (
                  <TokenRow key={record.id} record={record} />
                ))}
              </View>
            )}
          </View>

          {/* Out-of-wallet tokens (PoC "issued" section). */}
          <View className="gap-2">
            <View className="flex-row items-baseline justify-between">
              <Text weight="semibold">{t("cashuIssued")}</Text>
              <Amount amount={groups.outTotal} unit={unit} hidden={hidden} locale={locale} />
            </View>
            {groups.out.length === 0 ? (
              <Surface>
                <Text className="opacity-70">{t("cashuIssuedEmpty")}</Text>
              </Surface>
            ) : (
              <View className="gap-2" testID="token-list-out">
                {groups.out.map((record) => (
                  <TokenRow key={record.id} record={record} />
                ))}
              </View>
            )}
          </View>

          <View className="gap-3 pt-2">
            {meltTarget !== null && (
              <Button
                label={
                  meltBusy
                    ? t("cashuMeltToMainMintProcessing")
                    : t("cashuMeltToMainMint", { mint: meltTarget.targetDisplayName })
                }
                variant="secondary"
                disabled={busy || store === null || seed === null}
                onPress={() => void runMeltToMain()}
                testID="tokens-melt-to-main"
              />
            )}
            <Button
              label={
                cleanupBusy
                  ? t("cashuChecking")
                  : groups.spentCount > 0
                    ? `${t("cashuCleanupSpent")} (${groups.spentCount})`
                    : t("cashuCleanupSpent")
              }
              variant="secondary"
              disabled={busy || store === null || (groups.mine.length === 0 && groups.out.length === 0)}
              onPress={() => void runCleanup()}
              testID="tokens-cleanup"
            />
            <Button
              label={restoreBusy ? t("restoring") : t("restoreTokens")}
              variant="secondary"
              disabled={busy || store === null || seed === null}
              onPress={() => void runRestore()}
              testID="tokens-restore"
            />
          </View>
        </>
      )}
    </ScrollView>
  );
}
