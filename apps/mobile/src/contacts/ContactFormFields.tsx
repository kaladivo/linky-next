/**
 * ContactFormFields — the four contact inputs shared by the add screen and
 * the edit mode of the contact detail (#27). PoC ContactNewPage /
 * ContactEditPage form column, RN edition:
 *
 * - name, npub, Lightning address, group;
 * - group suggestions from the existing group names (the PoC's <datalist>)
 *   as tappable chips under the group input;
 * - optional per-field ↺ restore buttons next to name / Lightning address
 *   (edit mode only — PoC `resetEditedContactFieldFromNostr`), shown when
 *   the contact has an npub and the field is non-empty.
 */
import { Text, colors } from "@linky/ui";
import { Pressable, TextInput, View } from "react-native";

import { useTranslator } from "../locales";
import { filterGroupSuggestions } from "./contactFormModel";
import type { ContactFormState } from "./contactFormModel";

export type RestorableField = "name" | "lnAddress";

const PLACEHOLDER_COLOR = colors.foreground + "66";

const inputClassName =
  "rounded-xl bg-background px-4 py-3 font-sans text-base text-foreground";

function FieldLabel({
  label,
  onRestore,
  restoreTestID,
  restoreLabel,
}: {
  readonly label: string;
  readonly onRestore?: (() => void) | undefined;
  readonly restoreTestID?: string;
  readonly restoreLabel?: string;
}) {
  return (
    <View className="flex-row items-center justify-between">
      <Text weight="semibold">{label}</Text>
      {onRestore !== undefined && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={restoreLabel}
          hitSlop={8}
          onPress={onRestore}
          testID={restoreTestID}
          className="h-7 w-9 items-center justify-center rounded-lg bg-background"
        >
          <Text className="text-base leading-5">↺</Text>
        </Pressable>
      )}
    </View>
  );
}

export interface ContactFormFieldsProps {
  readonly form: ContactFormState;
  readonly onChange: (form: ContactFormState) => void;
  /** Existing group names (ContactsRepository.listGroups). */
  readonly groups: ReadonlyArray<string>;
  /** Edit mode: per-field restore-from-Nostr (PoC ↺). Omit on the add screen. */
  readonly onRestoreField?: (field: RestorableField) => void;
  readonly disabled?: boolean;
}

export function ContactFormFields({
  form,
  onChange,
  groups,
  onRestoreField,
  disabled = false,
}: ContactFormFieldsProps) {
  const t = useTranslator();
  const suggestions = filterGroupSuggestions(groups, form.group);
  const hasNpub = form.npub.trim().length > 0;

  const restoreFor = (field: RestorableField): (() => void) | undefined =>
    onRestoreField !== undefined && hasNpub && form[field].trim().length > 0
      ? () => onRestoreField(field)
      : undefined;

  return (
    <View className="gap-4">
      <View className="gap-2">
        <FieldLabel
          label={t("name")}
          onRestore={restoreFor("name")}
          restoreTestID="contact-restore-name"
          restoreLabel={t("restore")}
        />
        <TextInput
          value={form.name}
          onChangeText={(name) => onChange({ ...form, name })}
          placeholder={t("namePlaceholder")}
          placeholderTextColor={PLACEHOLDER_COLOR}
          autoCapitalize="words"
          autoCorrect={false}
          editable={!disabled}
          className={inputClassName}
          testID="contact-name-input"
        />
      </View>

      <View className="gap-2">
        <FieldLabel label={t("npub")} />
        <TextInput
          value={form.npub}
          onChangeText={(npub) => onChange({ ...form, npub })}
          placeholder={t("npubPlaceholder")}
          placeholderTextColor={PLACEHOLDER_COLOR}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!disabled}
          className={inputClassName}
          testID="contact-npub-input"
        />
      </View>

      <View className="gap-2">
        <FieldLabel
          label={t("lightningAddress")}
          onRestore={restoreFor("lnAddress")}
          restoreTestID="contact-restore-ln"
          restoreLabel={t("restore")}
        />
        <TextInput
          value={form.lnAddress}
          onChangeText={(lnAddress) => onChange({ ...form, lnAddress })}
          placeholder={t("lightningAddressPlaceholder")}
          placeholderTextColor={PLACEHOLDER_COLOR}
          autoCapitalize="none"
          autoCorrect={false}
          inputMode="email"
          editable={!disabled}
          className={inputClassName}
          testID="contact-ln-input"
        />
      </View>

      <View className="gap-2">
        <FieldLabel label={t("group")} />
        <TextInput
          value={form.group}
          onChangeText={(group) => onChange({ ...form, group })}
          placeholder={t("groupPlaceholder")}
          placeholderTextColor={PLACEHOLDER_COLOR}
          autoCapitalize="words"
          autoCorrect={false}
          editable={!disabled}
          className={inputClassName}
          testID="contact-group-input"
        />
        {suggestions.length > 0 && (
          <View className="flex-row flex-wrap gap-2" testID="contact-group-suggestions">
            {suggestions.map((group) => (
              <Pressable
                key={group}
                accessibilityRole="button"
                onPress={() => onChange({ ...form, group })}
                disabled={disabled}
                className="rounded-full bg-background px-4 py-1.5 active:opacity-70"
                testID={`contact-group-suggestion-${group}`}
              >
                <Text className="text-sm">{group}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>
    </View>
  );
}
