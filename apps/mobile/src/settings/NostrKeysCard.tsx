/**
 * "Nostr keys" card on Advanced settings (#20, pairs with
 * `advanced.nostr-keys` in #56): shows the ACTIVE npub and its source
 * (derived default vs custom override), lets the user paste a custom nsec
 * (with validation feedback), revert to the derived key, and copy npub /
 * nsec.
 *
 * Destructive or sensitive actions follow the PoC's "armed" two-tap
 * pattern (AdvancedPage.tsx): the first tap arms the action for 5 seconds
 * and shows a hint toast, the second tap within the window confirms.
 * Copying the nsec is armed too (it reveals a private key); copying the
 * npub is a plain tap.
 */
import { Button, Surface, Text } from "@linky/ui";
import { useEffect, useRef, useState } from "react";
import { TextInput, View } from "react-native";

import { useTranslator } from "../locales";
import { useSession } from "../session/useSession";
import { toast } from "../toast";
import {
  activateCustomKey,
  copyToClipboard,
  readClipboardText,
  revertToDerivedKey,
} from "./nostrKeyActions";

type ArmedAction = "activate" | "revert" | "copy-nsec";

const ARM_TIMEOUT_MS = 5000;

export function NostrKeysCard() {
  const t = useTranslator();
  const session = useSession();

  const [nsecInput, setNsecInput] = useState("");
  const [invalidPaste, setInvalidPaste] = useState(false);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState<ArmedAction | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any pending arm timer on unmount.
  useEffect(
    () => () => {
      if (armTimer.current !== null) clearTimeout(armTimer.current);
    },
    [],
  );

  const disarm = () => {
    if (armTimer.current !== null) clearTimeout(armTimer.current);
    armTimer.current = null;
    setArmed(null);
  };

  const arm = (action: ArmedAction, hint: string) => {
    if (armTimer.current !== null) clearTimeout(armTimer.current);
    setArmed(action);
    toast.info(hint);
    armTimer.current = setTimeout(() => setArmed(null), ARM_TIMEOUT_MS);
  };

  /** First tap arms with `hint`; second tap within the window runs `action`. */
  const confirmThen = (action: ArmedAction, hint: string, run: () => void) => () => {
    if (armed === action) {
      disarm();
      run();
      return;
    }
    arm(action, hint);
  };

  if (session.status === "loading") return null;
  if (session.status === "error" || session.data._tag !== "IdentityLoaded") {
    return (
      <Surface className="gap-2" testID="nostr-keys-card">
        <Text weight="semibold" className="text-primary">
          {t("nostrKeys")}
        </Text>
        <Text className="text-sm text-danger">{t("nostrKeyUpdateFailed")}</Text>
      </Surface>
    );
  }

  const active = session.data.session.activeNostr;
  const isCustom = active.source === "custom";

  const onActivate = () => {
    setBusy(true);
    setInvalidPaste(false);
    activateCustomKey(nsecInput)
      .then((result) => {
        if (result === "activated") {
          setNsecInput("");
          toast.success(t("nostrKeysUpdated"));
        } else if (result === "invalid") {
          setInvalidPaste(true);
        } else {
          toast.error(t("nostrKeyUpdateFailed"));
        }
      })
      .catch(() => toast.error(t("nostrKeyUpdateFailed")))
      .finally(() => setBusy(false));
  };

  const onRevert = () => {
    setBusy(true);
    revertToDerivedKey()
      .then((ok) => {
        if (ok) toast.success(t("nostrKeysDerived"));
        else toast.error(t("nostrKeyUpdateFailed"));
      })
      .catch(() => toast.error(t("nostrKeyUpdateFailed")))
      .finally(() => setBusy(false));
  };

  const copy = (value: string, doneMessage: string) => {
    void copyToClipboard(value).then((ok) => {
      if (ok) toast.success(doneMessage);
      else toast.error(t("copyFailed"));
    });
  };

  return (
    <Surface className="gap-3" testID="nostr-keys-card">
      <Text weight="semibold" className="text-primary">
        {t("nostrKeys")}
      </Text>

      <View className="gap-1">
        <Text className="text-sm opacity-70" testID="nostr-keys-source">
          {isCustom ? t("nostrKeySourceCustom") : t("nostrKeySourceDerived")}
        </Text>
        <Text className="text-sm" testID="nostr-keys-npub">
          {active.identity.npub}
        </Text>
      </View>

      <View className="flex-row gap-3">
        <Button
          label={t("nostrCopyNpub")}
          variant="secondary"
          className="flex-1"
          testID="nostr-copy-npub"
          onPress={() => copy(active.identity.npub, t("copiedToClipboard"))}
        />
        <Button
          label={t("nostrCopyNsec")}
          variant={armed === "copy-nsec" ? "danger" : "secondary"}
          className="flex-1"
          testID="nostr-copy-nsec"
          onPress={confirmThen("copy-nsec", t("nostrCopyNsecArmedHint"), () =>
            copy(active.identity.nsec, t("nostrKeysCopied")),
          )}
        />
      </View>

      {isCustom ? (
        <Button
          label={t("nostrRevertToDerived")}
          variant={armed === "revert" ? "danger" : "primary"}
          disabled={busy}
          testID="nostr-revert-derived"
          onPress={confirmThen("revert", t("nostrDeriveArmedHint"), onRevert)}
        />
      ) : (
        <View className="gap-2">
          <TextInput
            className="rounded-xl border border-surface bg-background px-4 py-3 text-foreground"
            placeholder={t("nostrPastePlaceholder")}
            placeholderTextColor="#64748b"
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            autoComplete="off"
            keyboardType="ascii-capable"
            value={nsecInput}
            onChangeText={(value) => {
              setNsecInput(value);
              setInvalidPaste(false);
              if (armed === "activate") disarm();
            }}
            testID="nostr-nsec-input"
          />
          <Button
            label={t("onboardingReturnPasteButton")}
            variant="secondary"
            testID="nostr-paste-clipboard"
            onPress={() => {
              void readClipboardText().then((text) => {
                if (text === null || text.trim() === "") {
                  toast.info(t("pasteEmpty"));
                  return;
                }
                setNsecInput(text.trim());
                setInvalidPaste(false);
              });
            }}
          />
          {invalidPaste && (
            <Text className="text-sm text-danger" testID="nostr-paste-invalid">
              {t("nostrPasteInvalid")}
            </Text>
          )}
          <Button
            label={t("nostrActivateCustomKey")}
            variant={armed === "activate" ? "danger" : "primary"}
            disabled={busy || nsecInput.trim() === ""}
            testID="nostr-activate-custom"
            onPress={confirmThen("activate", t("nostrPasteArmedHint"), onActivate)}
          />
        </View>
      )}
    </Surface>
  );
}
