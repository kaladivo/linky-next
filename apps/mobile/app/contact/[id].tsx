/**
 * Contact detail + edit (#27, `contacts.edit` / `contacts.refresh-nostr` /
 * `contacts.archive`). PoC's ContactPage + ContactEditPage merged into one
 * screen with a view mode and an edit mode:
 *
 * - View: avatar (deterministic, like the list rows), name, group,
 *   Lightning address, short npub, Message (chat/[id]) + Edit + the
 *   explicit "Refresh from Nostr" button (feature map: refresh lives on
 *   the contact detail; PoC rules — fetched kind-0 overwrites name +
 *   Lightning address directly, npub is canonicalized, history untouched).
 * - Edit: the shared form fields with group suggestions, per-field ↺
 *   restore-from-Nostr on name/Lightning address (PoC
 *   `resetEditedContactFieldFromNostr`: clear the override, then refetch
 *   and repopulate), save-changes enabled only when dirty & identifying
 *   (PoC `contactEditsSavable`), and the archive controls:
 *   - active contact: two-tap armed "Archive contact" (PoC pendingDeleteId,
 *     5 s timeout) — archiving only stamps `archivedAtSec`, chat/payment
 *     history is never deleted;
 *   - archived contact: "Restore contact". (The PoC also offers Block here
 *     — that lands with the block/unknown-sender work, not #27.)
 *
 * The PoC contact screen has no delete button (its "delete" IS the
 * archive). #28 adds the two lifecycle actions on top of this screen:
 * Delete contact → delete-to-unknown (conversation preserved under a
 * local-only unknown thread; tombstone syncs so no device recreates the
 * row), and Block on archived contacts (local block + merged kind-10000
 * mute-list publish) — both via src/contacts/contactThreadActions.
 */
import { deriveGeneratedAvatar } from "@linky/core";
import { Button, Surface, Text } from "@linky/ui";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Image, Pressable, ScrollView, View } from "react-native";

import { ContactFormFields } from "../../src/contacts/ContactFormFields";
import type { RestorableField } from "../../src/contacts/ContactFormFields";
import {
  archiveContact,
  refreshContactFromNostr,
  unarchiveContact,
  updateContact,
} from "../../src/contacts/contactActions";
import {
  contactPatchFromValues,
  emptyContactForm,
  findDuplicateContact,
  formFromRecord,
  isContactEditSavable,
  validateContactForm,
  valuesFromRecord,
} from "../../src/contacts/contactFormModel";
import type { ContactFormState } from "../../src/contacts/contactFormModel";
import {
  blockArchivedContact,
  deleteContactToUnknown,
} from "../../src/contacts/contactThreadActions";
import { contactDisplayName, shortNpub } from "../../src/contacts/contactsListModel";
import { useContactEditorData } from "../../src/contacts/useContactEditorData";
import { useLocale } from "../../src/locales";
import { toAvatarDisplayUrl } from "../../src/onboarding/avatarDisplay";
import { useSession } from "../../src/session/useSession";
import { useLinkyStore } from "../../src/store/useLinkyStore";
import { toast } from "../../src/toast";

import type { ContactRecord, LinkyStore } from "@linky/evolu-store";

/** 96pt detail avatar; 288px covers @3x. */
const AVATAR_PX = 288;
/** PoC useArmedDeleteTimeouts: an armed archive disarms after 5 s. */
const ARCHIVE_ARM_TIMEOUT_MS = 5000;

const initialsOf = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((part) => part.slice(0, 1).toUpperCase());
  return letters.join("") || "?";
};

function ContactAvatar({ npub, displayName }: { npub: string | null; displayName: string }) {
  const avatarUrl =
    npub === null ? null : toAvatarDisplayUrl(deriveGeneratedAvatar(npub).pictureUrl, AVATAR_PX);
  return (
    <View className="h-24 w-24 items-center justify-center overflow-hidden rounded-full bg-surface">
      {avatarUrl !== null ? (
        <Image source={{ uri: avatarUrl }} className="h-24 w-24" resizeMode="cover" />
      ) : (
        <Text weight="semibold" className="text-2xl">
          {initialsOf(displayName)}
        </Text>
      )}
    </View>
  );
}

function ContactScreenBody({
  store,
  record,
  contacts,
  groups,
  ownNpub,
}: {
  readonly store: LinkyStore;
  readonly record: ContactRecord;
  readonly contacts: ReadonlyArray<ContactRecord>;
  readonly groups: ReadonlyArray<string>;
  readonly ownNpub: string | null;
}) {
  const { t, locale } = useLocale();
  const router = useRouter();

  const [mode, setMode] = useState<"view" | "edit">("view");
  const [form, setForm] = useState<ContactFormState>(emptyContactForm());
  const [busy, setBusy] = useState(false);
  const [archiveArmed, setArchiveArmed] = useState(false);

  // PoC useArmedDeleteTimeouts: the armed state disarms itself.
  useEffect(() => {
    if (!archiveArmed) return;
    const timer = setTimeout(() => setArchiveArmed(false), ARCHIVE_ARM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [archiveArmed]);

  const displayName = contactDisplayName(record, locale);
  const isArchived = record.archivedAtSec !== null;

  const enterEdit = () => {
    setForm(formFromRecord(record));
    setArchiveArmed(false);
    setMode("edit");
  };

  const onRefresh = () => {
    if (busy) return;
    setBusy(true);
    refreshContactFromNostr(store, record)
      .then((outcome) => {
        if (outcome.kind === "refreshed") toast.success(t("contactRefreshed"));
        else if (outcome.kind === "no-profile") toast.error(t("contactRefreshNoProfile"));
        else toast.error(t("invalidNpub"));
      })
      .finally(() => setBusy(false));
  };

  // PoC resetEditedContactFieldFromNostr: clear the custom value (persisted
  // immediately), then refetch the kind-0 and repopulate from it.
  const onRestoreField = (field: RestorableField) => {
    if (busy) return;
    setForm((prev) => ({ ...prev, [field]: "" }));
    updateContact(store, record.id, { [field]: null });
    setBusy(true);
    refreshContactFromNostr(store, { id: record.id, npub: form.npub })
      .then((outcome) => {
        if (outcome.kind === "refreshed") {
          const { patch } = outcome;
          setForm((prev) => ({
            ...prev,
            ...(typeof patch.name === "string" ? { name: patch.name } : {}),
            ...(typeof patch.lnAddress === "string" ? { lnAddress: patch.lnAddress } : {}),
            ...(typeof patch.npub === "string" ? { npub: patch.npub } : {}),
          }));
        } else if (outcome.kind === "no-profile") {
          toast.error(t("contactRefreshNoProfile"));
        }
      })
      .finally(() => setBusy(false));
  };

  const onSaveChanges = () => {
    const validation = validateContactForm(form, { ownNpub, originalNpub: record.npub });
    switch (validation.kind) {
      case "empty":
        toast.error(t("fillAtLeastOne"));
        return;
      case "invalidNpub":
        toast.error(t("invalidNpub"));
        return;
      case "self":
        toast.error(t("contactIsYou"));
        return;
      case "valid":
        break;
    }

    const duplicate = findDuplicateContact(contacts, validation.values, record.id);
    if (duplicate !== null) {
      // PoC dedup UX: report and open the contact already holding the value.
      toast.error(t("contactExists"));
      router.push(`/contact/${duplicate.id}`);
      return;
    }

    updateContact(store, record.id, contactPatchFromValues(valuesFromRecord(record), validation.values));
    toast.success(t("contactUpdated"));
    setMode("view");
  };

  const onArchive = () => {
    if (!archiveArmed) {
      setArchiveArmed(true);
      return;
    }
    setArchiveArmed(false);
    archiveContact(store, record.id);
    toast.success(t("contactArchived"));
    setMode("view");
  };

  const onUnarchive = () => {
    unarchiveContact(store, record.id);
    toast.success(t("contactRestored"));
    setMode("view");
  };

  // #28 contacts.delete-to-unknown: confirm, soft-delete the contact row,
  // preserve any conversation under a local-only unknown thread.
  const onDelete = () => {
    if (busy) return;
    Alert.alert(t("deleteContact"), t("deleteContactConfirm"), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("deleteContact"),
        style: "destructive",
        onPress: () => {
          setBusy(true);
          void deleteContactToUnknown(store, record.id)
            .then((result) => {
              if (result === "failed") {
                toast.error(t("errorPrefix"));
                return;
              }
              toast.success(t("contactDeleted"));
              router.replace("/(tabs)");
            })
            .finally(() => setBusy(false));
        },
      },
    ]);
  };

  // #28 contacts.block (archived contacts, PoC parity): confirm, local
  // block + merged kind-10000 mute-list publish, contact row removed.
  const onBlock = () => {
    if (busy) return;
    Alert.alert(t("blockContact"), t("chatUnknownContactBlockConfirm"), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("blockContact"),
        style: "destructive",
        onPress: () => {
          setBusy(true);
          void blockArchivedContact(store, record.id)
            .then((result) => {
              if (!result.blocked) {
                toast.error(t("errorPrefix"));
                return;
              }
              toast.success(t("contactBlocked"));
              router.replace("/(tabs)");
            })
            .finally(() => setBusy(false));
        },
      },
    ]);
  };

  if (mode === "edit") {
    const savable = isContactEditSavable(formFromRecord(record), form) && !busy;
    return (
      <>
        <Stack.Screen options={{ title: t("contactEditTitle") }} />
        <ScrollView
          className="flex-1 bg-background"
          contentContainerClassName="gap-4 px-6 py-4 pb-10"
          keyboardShouldPersistTaps="handled"
          testID="contact-edit-screen"
        >
          <Surface className="gap-4">
            <ContactFormFields
              form={form}
              onChange={setForm}
              groups={groups}
              onRestoreField={onRestoreField}
              disabled={busy}
            />
          </Surface>

          <Button
            label={t("saveChanges")}
            disabled={!savable}
            onPress={onSaveChanges}
            testID="contact-save-changes"
          />

          {isArchived ? (
            <>
              <Button
                label={t("restoreArchivedContact")}
                variant="secondary"
                onPress={onUnarchive}
                testID="contact-unarchive"
              />
              <Button
                label={t("blockContact")}
                variant="danger"
                disabled={busy}
                testID="contact-block"
                onPress={onBlock}
              />
            </>
          ) : (
            <>
              <Button
                label={t("archiveContact")}
                variant={archiveArmed ? "danger" : "secondary"}
                onPress={onArchive}
                testID="contact-archive"
              />
              {archiveArmed && (
                <Text className="text-center text-sm text-danger" testID="contact-archive-hint">
                  {t("archiveArmedHint")}
                </Text>
              )}
            </>
          )}

          <Button
            label={t("deleteContact")}
            variant="danger"
            disabled={busy}
            testID="contact-delete"
            onPress={onDelete}
          />

          <Button
            label={t("cancel")}
            variant="secondary"
            onPress={() => setMode("view")}
            testID="contact-edit-cancel"
          />
        </ScrollView>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: displayName }} />
      <ScrollView
        className="flex-1 bg-background"
        contentContainerClassName="gap-4 px-6 py-4 pb-10"
        testID="contact-detail-screen"
      >
        <View className="items-center gap-3 pt-2">
          <View>
            <ContactAvatar npub={record.npub} displayName={displayName} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("editContact")}
              hitSlop={8}
              onPress={enterEdit}
              testID="contact-edit"
              className="absolute -right-2 -top-1 h-9 w-9 items-center justify-center rounded-full bg-surface"
            >
              <Text className="text-base">✎</Text>
            </Pressable>
          </View>

          <View className="items-center gap-1">
            <Text weight="bold" className="text-2xl" testID="contact-detail-name">
              {displayName}
            </Text>
            {isArchived && (
              <View className="rounded-full bg-surface px-3 py-1" testID="contact-archived-badge">
                <Text className="text-xs uppercase tracking-widest opacity-60">
                  {t("archiveFilter")}
                </Text>
              </View>
            )}
            {record.groupName !== null && (
              <Text className="text-sm opacity-60" testID="contact-detail-group">
                {record.groupName}
              </Text>
            )}
          </View>
        </View>

        {(record.lnAddress !== null || record.npub !== null) && (
          <Surface className="gap-3">
            {record.lnAddress !== null && (
              <View className="gap-0.5">
                <Text className="text-xs uppercase tracking-widest opacity-50">
                  {t("lightningAddress")}
                </Text>
                <Text className="text-sm" testID="contact-detail-ln">
                  {record.lnAddress}
                </Text>
              </View>
            )}
            {record.npub !== null && (
              <View className="gap-0.5">
                <Text className="text-xs uppercase tracking-widest opacity-50">{t("npub")}</Text>
                <Text className="text-sm" testID="contact-detail-npub">
                  {shortNpub(record.npub)}
                </Text>
              </View>
            )}
          </Surface>
        )}

        {record.npub !== null && (
          <Button
            label={t("sendMessage")}
            onPress={() => router.push(`/chat/${record.id}`)}
            testID="contact-message"
          />
        )}
        {record.npub !== null && (
          <Button
            label={t("refreshFromNostr")}
            variant="secondary"
            disabled={busy}
            onPress={onRefresh}
            testID="contact-refresh-nostr"
          />
        )}
      </ScrollView>
    </>
  );
}

export default function ContactDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useLocale();
  const storeState = useLinkyStore();
  const session = useSession();

  const store = storeState.status === "ready" ? storeState.store : null;
  const data = useContactEditorData(store, id ?? null);

  const ownNpub =
    session.status === "success" && session.data._tag === "IdentityLoaded"
      ? session.data.session.activeNostr.identity.npub
      : null;

  if (store === null || data.status !== "ready") {
    return (
      <>
        <Stack.Screen options={{ title: t("contact") }} />
        <View className="flex-1 bg-background px-6 pt-4">
          <Text className="text-sm opacity-60">{t("loadingMore")}</Text>
        </View>
      </>
    );
  }

  if (data.data.record === null) {
    return (
      <>
        <Stack.Screen options={{ title: t("contact") }} />
        <View className="flex-1 bg-background px-6 pt-4">
          <Text className="opacity-70" testID="contact-not-found">
            {t("contactNotFound")}
          </Text>
        </View>
      </>
    );
  }

  return (
    <ContactScreenBody
      store={store}
      record={data.data.record}
      contacts={data.data.contacts}
      groups={data.data.groups}
      ownNpub={ownNpub}
    />
  );
}
