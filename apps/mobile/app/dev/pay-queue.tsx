/**
 * DEV-ONLY pending-payment queue lab (#46 verification hook).
 *
 * Simulating a real offline window on a simulator is global and flaky
 * (Wi-Fi toggles hit every app); this screen exercises the queue machinery
 * deterministically instead:
 *
 * - "Queue intent" writes a pending spend row (phase "queued") + a queue
 *   intent for the first npub-bearing contact — exactly the state an
 *   offline send leaves behind;
 * - "Flush now" runs the production flush (mint reachable → the retry
 *   mints + delivers for real; unreachable → the intent re-queues);
 * - "Expire all" backdates every intent past the 24 h window, then a flush
 *   shows the funds-returned UX (expired row pill + toast);
 * - the pay-with-cashu toggle stands in for the #56 settings UI so the
 *   `chat-pay.contact-method` gating is verifiable today.
 *
 * Gated to the development profile like /dev/link-lab.
 */
import { Button, Surface, Text } from "@linky/ui";
import { Redirect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { makeClientTag, nowSec } from "../../src/chat/chatActions";
import {
  devExpirePendingPayments,
  enqueuePendingPayment,
  flushPendingPayments,
  listPendingPayments,
} from "../../src/chat/pendingPaymentQueue";
import {
  CHAT_PAY_TRANSACTION_CATEGORY,
  CHAT_PAY_TRANSACTION_METHOD,
} from "../../src/chat/chatPaymentsModel";
import type { PendingPaymentIntent } from "../../src/chat/pendingPaymentsModel";
import { appProfile } from "../../src/environment";
import { runAppEffect } from "../../src/runtime";
import { useLinkyStore } from "../../src/store/useLinkyStore";
import { invalidateStoreData } from "../../src/store/storeManager";
import { toast } from "../../src/toast";
import { QUEUED_TRANSACTION_PHASE } from "../../src/wallet/transactionsModel";
import {
  loadPayWithCashuEnabled,
  persistPayWithCashuEnabled,
} from "../../src/wallet/payWithCashuSetting";
import {
  createContactsRepository,
  createTransactionsRepository,
} from "@linky/evolu-store";

export default function DevPayQueueScreen() {
  const storeState = useLinkyStore();
  const store = storeState.status === "ready" ? storeState.store : null;
  const [intents, setIntents] = useState<ReadonlyArray<PendingPaymentIntent>>([]);
  const [cashuEnabled, setCashuEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void listPendingPayments().then(setIntents);
    void runAppEffect(loadPayWithCashuEnabled).then(setCashuEnabled);
  }, []);

  useEffect(refresh, [refresh]);

  if (appProfile !== "development") return <Redirect href="/" />;

  const run = (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    void work()
      .catch((error: unknown) => toast.error(String(error)))
      .finally(() => {
        setBusy(false);
        refresh();
      });
  };

  const queueTestIntent = () =>
    run(async () => {
      if (store === null) throw new Error("store not ready");
      const contacts = await createContactsRepository(store).list();
      const contact = contacts.find((entry) => String(entry.npub ?? "").trim() !== "");
      if (contact === undefined) throw new Error("no contact with an npub");
      const amountSat = 21;
      const row = createTransactionsRepository(store).record({
        happenedAtSec: Math.max(1, Math.floor(Date.now() / 1000)),
        direction: "out",
        status: "pending",
        category: CHAT_PAY_TRANSACTION_CATEGORY,
        method: CHAT_PAY_TRANSACTION_METHOD,
        phase: QUEUED_TRANSACTION_PHASE,
        amount: amountSat,
        unit: "sat",
        contactId: contact.id,
      });
      if (!row.ok) throw new Error(`record failed: ${row.error._tag}`);
      invalidateStoreData();
      await enqueuePendingPayment({
        id: makeClientTag(),
        contactId: contact.id,
        peerNpub: String(contact.npub),
        amountSat,
        createdAtSec: nowSec(),
        transactionId: row.value.id,
      });
      toast.success(`queued ${amountSat} sat → ${String(contact.name ?? contact.id)}`);
    });

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView contentContainerClassName="gap-4 px-6 py-4">
        <Text weight="bold" className="text-2xl">
          dev/pay-queue
        </Text>

        <Surface className="gap-3" testID="dev-pay-queue">
          <Text weight="semibold">Pending payment intents ({intents.length})</Text>
          {intents.length === 0 && <Text className="text-sm opacity-60">queue empty</Text>}
          {intents.map((intent) => (
            <View key={intent.id} className="rounded-xl bg-background px-3 py-2">
              <Text className="text-sm">
                {intent.amountSat} sat → contact {intent.contactId.slice(0, 8)}…
              </Text>
              <Text className="text-xs opacity-60">
                age {Math.max(0, nowSec() - intent.createdAtSec)}s · tx{" "}
                {intent.transactionId.slice(0, 8)}… · id {intent.id}
              </Text>
            </View>
          ))}
          <Button
            label="Queue 21 sat intent (first npub contact)"
            variant="secondary"
            disabled={busy || store === null}
            testID="dev-pay-queue-enqueue"
            onPress={queueTestIntent}
          />
          <Button
            label="Flush now"
            variant="primary"
            disabled={busy}
            testID="dev-pay-queue-flush"
            onPress={() => run(() => flushPendingPayments())}
          />
          <Button
            label="Expire all (backdate 24h+)"
            variant="secondary"
            disabled={busy}
            testID="dev-pay-queue-expire"
            onPress={() => run(() => devExpirePendingPayments())}
          />
          <Button label="Refresh" variant="secondary" disabled={busy} onPress={refresh} />
        </Surface>

        <Surface className="gap-3" testID="dev-pay-with-cashu">
          <Text weight="semibold">
            settings.pay-with-cashu: {cashuEnabled === null ? "…" : cashuEnabled ? "ON" : "OFF"}
          </Text>
          <Text className="text-xs opacity-60">
            Stand-in for the #56 settings UI — gates the Cashu option in the chat pay sheet.
          </Text>
          <Button
            label={cashuEnabled === false ? "Enable pay-with-cashu" : "Disable pay-with-cashu"}
            variant="secondary"
            disabled={busy || cashuEnabled === null}
            testID="dev-pay-with-cashu-toggle"
            onPress={() =>
              run(() => runAppEffect(persistPayWithCashuEnabled(cashuEnabled === false)))
            }
          />
        </Surface>
      </ScrollView>
    </SafeAreaView>
  );
}
