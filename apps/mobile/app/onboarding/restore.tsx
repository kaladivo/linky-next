/**
 * `onboarding.restore-account` / `identity.restore` (#18) — "I'm returning".
 *
 * 20-word backup entry, PoC-forgiving: word chips with invalid-word
 * highlighting, live n/20 count, prefix suggestions while typing, paste of a
 * full phrase anywhere (TextInput paste or the clipboard button) fills all
 * words, chips editable in place (tap to edit, backspace to pop/delete).
 * All mechanics live in src/onboarding/restorePhraseInput.ts (pure, vitest);
 * word validation/suggestions come from core's restore-UI helpers.
 *
 * Success runs core `restoreIdentitySession` (derive + persist) via
 * `restoreAccount`, then replaces to the tabs — the #14/#16 session gate
 * keeps the user there from now on. Failures render TYPED errors inline
 * (checksum vs unknown words vs storage); the words themselves never reach
 * a logger.
 */
import type { InvalidBackupPhraseError, SecureStorageError } from "@linky/core";
import type { Translator } from "@linky/locales";
import { Button, colors, Surface, Text } from "@linky/ui";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTranslator } from "../../src/locales";
import { readClipboardText, restoreAccount } from "../../src/onboarding/onboardingActions";
import {
  applySuggestion,
  changeDraft,
  commitDraft,
  deleteBackFromEmptyDraft,
  describeRestorePhrase,
  emptyRestorePhraseState,
  type RestoreWordChipStatus,
  startEditingWord,
} from "../../src/onboarding/restorePhraseInput";
import { useEffectMutation } from "../../src/runtime";

const BACKUP_WORD_TOTAL = 20;

/** Chip styling per status: invalid words get the danger treatment. */
const chipClassName: Record<RestoreWordChipStatus, string> = {
  valid: "bg-background",
  invalid: "bg-background border border-danger",
  editing: "bg-background border border-primary",
};

const chipTextClassName: Record<RestoreWordChipStatus, string> = {
  valid: "text-foreground",
  invalid: "text-danger",
  editing: "text-primary",
};

/**
 * Inline message for a failed restore. Word-level detail (`unknownWords`)
 * is dictionary material and stays strictly in the UI.
 */
const restoreErrorMessage = (
  t: Translator,
  error: InvalidBackupPhraseError | SecureStorageError,
): string => {
  if (error._tag === "InvalidBackupPhraseError") {
    switch (error.reason) {
      case "unknown-words":
        return t("onboardingReturnUnknownWords", {
          words: error.unknownWords.slice(0, 3).join(", "),
        });
      case "checksum":
        return t("onboardingRestoreChecksum");
      case "word-count":
        return error.wordCount > BACKUP_WORD_TOTAL
          ? t("onboardingReturnTooManyWords")
          : t("onboardingReturnHint");
      // share-format / unsupported-share: structurally not a Linky backup.
      default:
        return t("onboardingInvalidSeed");
    }
  }
  return `${t("onboardingRestoreFailed")} (${error._tag})`;
};

export default function RestoreAccountScreen() {
  const t = useTranslator();
  const router = useRouter();
  const inputRef = useRef<TextInput>(null);

  const [entry, setEntry] = useState(emptyRestorePhraseState);
  const view = describeRestorePhrase(entry);

  const restore = useEffectMutation((phrase: string) => restoreAccount(phrase));
  const paste = useEffectMutation(() => readClipboardText);
  const busy = restore.state.status === "pending" || restore.state.status === "success";

  useEffect(() => {
    if (restore.state.status === "success") {
      // Identity persisted + session invalidated: straight into the app
      // (returning users have no profile-setup step; synced data reattaches
      // from the restored identity's lanes — #25/#35).
      router.replace("/(tabs)");
    }
  }, [restore.state.status, router]);

  // A clipboard read goes through the same path as typing/pasting into the
  // TextInput, so a full phrase fills all 20 chips. Like any other edit it
  // clears a stale error from a previous attempt.
  useEffect(() => {
    if (paste.state.status === "success" && paste.state.data !== null) {
      const text = paste.state.data;
      if (restore.state.status === "error") restore.reset();
      setEntry((current) => changeDraft(current, text));
      paste.reset();
    }
  }, [paste, restore]);

  // Any edit after a failed attempt clears the stale error.
  const update = (next: typeof entry) => {
    if (restore.state.status === "error") restore.reset();
    setEntry(next);
  };

  const invalidWords = view.chips
    .filter((chip) => chip.status === "invalid")
    .map((chip) => chip.text);
  const helper =
    restore.state.status === "error"
      ? restoreErrorMessage(t, restore.state.error)
      : view.tooManyWords
        ? t("onboardingReturnTooManyWords")
        : invalidWords.length > 0
          ? t("onboardingReturnUnknownWords", { words: invalidWords.slice(0, 3).join(", ") })
          : t("onboardingReturnHint");
  const helperIsProblem =
    restore.state.status === "error" || view.tooManyWords || invalidWords.length > 0;

  return (
    <SafeAreaView className="flex-1 bg-background">
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          className="flex-1"
          contentContainerClassName="gap-5 px-6 py-6"
          keyboardShouldPersistTaps="handled"
        >
          <View className="gap-2" testID="onboarding-restore">
            <Text weight="bold" className="text-3xl">
              {t("onboardingReturn")}
            </Text>
            <Text className="opacity-70">{t("onboardingReturnIntro")}</Text>
          </View>

          <Surface className="gap-3">
            <View className="flex-row items-center justify-between">
              <Text weight="semibold">{t("seed")}</Text>
              <Text className="text-sm opacity-70" testID="restore-word-count">
                {t("onboardingReturnWordCount", {
                  count: view.wordCount,
                  total: BACKUP_WORD_TOTAL,
                })}
              </Text>
            </View>

            {view.chips.length > 0 && (
              <View className="flex-row flex-wrap gap-2" testID="restore-word-chips">
                {view.chips.map((chip) => (
                  <Pressable
                    key={chip.index}
                    accessibilityRole="button"
                    accessibilityLabel={`${chip.index + 1}. ${chip.text}`}
                    disabled={busy}
                    onPress={() => {
                      update(startEditingWord(entry, chip.index));
                      inputRef.current?.focus();
                    }}
                    className={`flex-row items-center gap-1 rounded-lg px-2.5 py-1.5 active:opacity-70 ${chipClassName[chip.status]}`}
                    testID={`restore-word-${chip.index}`}
                  >
                    <Text className="text-xs opacity-50">{chip.index + 1}</Text>
                    <Text className={`text-sm ${chipTextClassName[chip.status]}`}>
                      {chip.text}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}

            <TextInput
              ref={inputRef}
              value={entry.draft}
              onChangeText={(text) => update(changeDraft(entry, text))}
              onSubmitEditing={() => update(commitDraft(entry))}
              onKeyPress={(event) => {
                if (event.nativeEvent.key === "Backspace" && entry.draft.length === 0) {
                  update(deleteBackFromEmptyDraft(entry));
                }
              }}
              placeholder={view.chips.length === 0 ? t("onboardingReturnPlaceholder") : ""}
              placeholderTextColor={colors.foreground + "66"}
              className="rounded-xl bg-background px-4 py-3 font-sans text-base text-foreground"
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              submitBehavior="submit"
              editable={!busy}
              autoFocus
              testID="restore-word-input"
            />

            {view.suggestions.length > 0 && (
              <View
                className="flex-row flex-wrap gap-2"
                accessibilityLabel={t("onboardingReturnSuggestions")}
                testID="restore-suggestions"
              >
                {view.suggestions.map((word) => (
                  <Pressable
                    key={word}
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => {
                      update(applySuggestion(entry, word));
                      inputRef.current?.focus();
                    }}
                    className="rounded-full bg-primary/15 px-3 py-1.5 active:opacity-70"
                    testID={`restore-suggestion-${word}`}
                  >
                    <Text className="text-sm text-primary">{word}</Text>
                  </Pressable>
                ))}
              </View>
            )}

            <Text
              className={`text-sm ${helperIsProblem ? "text-danger" : "opacity-70"}`}
              testID="restore-helper"
            >
              {helper}
            </Text>

            <Button
              label={t("onboardingReturnPasteButton")}
              variant="secondary"
              disabled={busy || paste.state.status === "pending"}
              onPress={() => paste.mutate()}
              testID="restore-paste"
            />
          </Surface>

          {busy && (
            <Surface className="flex-row items-center gap-3" testID="restore-restoring">
              <ActivityIndicator />
              <Text>{t("onboardingRestoring")}</Text>
            </Surface>
          )}

          <Button
            label={t("onboardingReturnConfirm")}
            disabled={busy || !view.canSubmit}
            onPress={() => restore.mutate(view.phrase)}
            testID="restore-confirm"
          />
          <Button
            label={t("back")}
            variant="secondary"
            disabled={busy}
            onPress={() => router.back()}
            testID="restore-back"
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
