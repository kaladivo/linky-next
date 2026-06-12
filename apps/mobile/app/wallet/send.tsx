/**
 * Send — manual-entry / paste pay entry (#39; `lightning.pay-address`,
 * `lightning.pay-invoice`, `lnurl.pay`). The scanner entry lands with #48;
 * this screen classifies the typed/pasted text with core's
 * `parseLightningInput` (PoC scanner order) and routes:
 *
 *   lightning address / LNURL-pay / unknown LNURL → /wallet/pay-address
 *   BOLT11 invoice                                → /wallet/pay-invoice
 *   LNURL-withdraw                                → unsupported here (#48)
 */
import { parseLightningInput } from "@linky/core";
import { Clipboard } from "@linky/core";
import { Button, Surface, Text } from "@linky/ui";
import { Effect, Option } from "effect";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ScrollView, TextInput, View } from "react-native";

import { useTranslator } from "../../src/locales";
import { runAppEffect } from "../../src/runtime";

export default function WalletSendScreen() {
  const t = useTranslator();
  const router = useRouter();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (raw: string) => {
    const input = raw.trim();
    if (input === "") return;
    void runAppEffect(Effect.either(parseLightningInput(input))).then((parsed) => {
      if (parsed._tag === "Left") {
        setError(t("sendUnrecognized"));
        return;
      }
      switch (parsed.right._tag) {
        case "Bolt11Input":
          router.push({
            pathname: "/wallet/pay-invoice",
            params: { invoice: parsed.right.invoice.invoice },
          });
          return;
        case "LightningAddressInput":
          router.push({
            pathname: "/wallet/pay-address",
            params: { target: parsed.right.address.address },
          });
          return;
        case "LnurlPayInput":
        case "LnurlInput":
          // Unknown LNURLs resolve at the metadata fetch (PoC: withdraw
          // first, pay on tag mismatch); the pay screen surfaces a
          // tag-mismatch error visibly.
          router.push({
            pathname: "/wallet/pay-address",
            params: { target: parsed.right.url },
          });
          return;
        case "LnurlWithdrawInput":
          setError(t("sendWithdrawUnsupported"));
          return;
      }
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
    </ScrollView>
  );
}
