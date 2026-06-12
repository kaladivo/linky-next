/**
 * Send — pay entry (#39/#48; `lightning.pay-address`, `lightning.pay-invoice`,
 * `lnurl.pay`). Manual/pasted text and the scanner (entry "send") both route
 * through #48's unified parse path (`routeScannedValue`), so this screen
 * accepts exactly what the send scan accepts:
 *
 *   BOLT11 invoice                                → /wallet/pay-invoice
 *   lightning address / LNURL-pay / unknown LNURL → /wallet/pay-address
 *   LNURL-withdraw                                → /wallet/lnurl-withdraw
 *   Cashu token                                   → wallet import (#38)
 *   npub                                          → contact flow (#27)
 *
 * (PoC parity: its send-scan handler banked tokens and saved npub contacts
 * from the send entry too.) Unrecognized input fails inline.
 */
import { Clipboard } from "@linky/core";
import { Button, Surface, Text } from "@linky/ui";
import { Effect, Option } from "effect";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ScrollView, TextInput, View } from "react-native";

import { useTranslator } from "../../src/locales";
import { runAppEffect } from "../../src/runtime";
import { routeScannedValue } from "../../src/scanner/scanResultHandler";

export default function WalletSendScreen() {
  const t = useTranslator();
  const router = useRouter();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (raw: string) => {
    const input = raw.trim();
    if (input === "") return;
    // The #48 unified path; push so cancel returns to this screen.
    void routeScannedValue(input, "send", { router, t, navigation: "push" }).then((outcome) => {
      if (outcome.kind === "unsupported") setError(outcome.message);
    });
  };

  const paste = () => {
    void runAppEffect(
      Clipboard.pipe(
        Effect.flatMap((clipboard) => clipboard.read),
        Effect.catchAll(() => Effect.succeed(Option.none<string>())),
      ),
    ).then((value) => {
      const pasted = Option.getOrNull(value)?.trim() ?? "";
      if (pasted === "") return;
      setError(null);
      setText(pasted);
      submit(pasted);
    });
  };

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 px-6 pb-8 pt-4">
      <Surface className="gap-3">
        <Text weight="semibold">{t("payTo")}</Text>
        <View className="rounded-xl bg-background px-4">
          <TextInput
            value={text}
            onChangeText={(next) => {
              setText(next);
              setError(null);
            }}
            placeholder={t("sendInputPlaceholder")}
            placeholderTextColor="#94a3b8"
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            testID="send-input"
            className="min-h-[72px] py-3 font-sans text-base text-foreground"
          />
        </View>
        {error !== null && (
          <Text className="text-sm text-danger" testID="send-error">
            {error}
          </Text>
        )}
        <View className="flex-row gap-3">
          <Button
            label={t("sendPaste")}
            variant="secondary"
            className="flex-1"
            onPress={paste}
            testID="send-paste"
          />
          <Button
            label={t("sendContinue")}
            variant="primary"
            className="flex-1"
            disabled={text.trim() === ""}
            onPress={() => submit(text)}
            testID="send-continue"
          />
        </View>
      </Surface>

      {/* Scanner with the send entry point (#48 `scanner.route-result`). */}
      <Button
        label={t("scan")}
        variant="secondary"
        onPress={() => router.push({ pathname: "/scanner", params: { entry: "send" } })}
        testID="send-scan"
      />
    </ScrollView>
  );
}
