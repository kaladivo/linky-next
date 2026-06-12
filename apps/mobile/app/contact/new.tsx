/**
 * Add contact (#27, `contacts.add`): name, npub (validated bech32),
 * Lightning address, group with suggestions from the existing groups.
 *
 * PoC `handleSaveContact` flow:
 * - at least one of name/npub/Lightning address (toast `fillAtLeastOne`);
 * - own npub refused (`contactIsYou`);
 * - duplicate npub/Lightning address -> toast `contactExists` AND the
 *   existing contact opens (PoC: navigate to the duplicate, never create);
 * - on success: save, toast `contactSaved`, warm the profile cache in the
 *   background, back to the contacts list.
 *
 * The scan path lands with #48 — the "Load QR" button is a disabled stub.
 */
import { Button, Surface, Text } from "@linky/ui";
import { Stack, useRouter } from "expo-router";
import { useState } from "react";
import { ScrollView } from "react-native";

import { ContactFormFields } from "../../src/contacts/ContactFormFields";
import {
  emptyContactForm,
  findDuplicateContact,
  validateContactForm,
} from "../../src/contacts/contactFormModel";
import type { ContactFormState } from "../../src/contacts/contactFormModel";
import { insertContact, prefetchContactProfile } from "../../src/contacts/contactActions";
import { useContactEditorData } from "../../src/contacts/useContactEditorData";
import { useTranslator } from "../../src/locales";
import { useSession } from "../../src/session/useSession";
import { useLinkyStore } from "../../src/store/useLinkyStore";
import { toast } from "../../src/toast";

export default function ContactNewScreen() {
  const t = useTranslator();
  const router = useRouter();
  const storeState = useLinkyStore();
  const session = useSession();
  const [form, setForm] = useState<ContactFormState>(emptyContactForm());

  const store = storeState.status === "ready" ? storeState.store : null;
  const data = useContactEditorData(store, null);

  const ownNpub =
    session.status === "success" && session.data._tag === "IdentityLoaded"
      ? session.data.session.activeNostr.identity.npub
      : null;

  const onSave = () => {
    if (store === null || data.status !== "ready") return;

    const validation = validateContactForm(form, { ownNpub });
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

    const duplicate = findDuplicateContact(data.data.contacts, validation.values);
    if (duplicate !== null) {
      // PoC dedup UX: never create a second row — tell the user and open
      // the contact that already holds this npub / Lightning address.
      toast.error(t("contactExists"));
      router.replace(`/contact/${duplicate.id}`);
      return;
    }

    insertContact(store, validation.values);
    if (validation.values.npub !== null) prefetchContactProfile(validation.values.npub);
    toast.success(t("contactSaved"));
    router.back();
  };

  const ready = store !== null && data.status === "ready";

  return (
    <>
      <Stack.Screen options={{ title: t("newContact") }} />
      <ScrollView
        className="flex-1 bg-background"
        contentContainerClassName="gap-4 px-6 py-4 pb-10"
        keyboardShouldPersistTaps="handled"
        testID="contact-new-screen"
      >
        {!ready ? (
          <Text className="text-sm opacity-60">{t("loadingMore")}</Text>
        ) : (
          <>
            <Surface className="gap-4">
              <ContactFormFields form={form} onChange={setForm} groups={data.data.groups} />
            </Surface>
            <Button label={t("saveContact")} onPress={onSave} testID="contact-save" />
            {/* TODO(#48): QR scan entry point — disabled stub until the scan flow lands. */}
            <Button
              label={t("contactLoadQr")}
              variant="secondary"
              disabled
              testID="contact-scan-stub"
            />
          </>
        )}
      </ScrollView>
    </>
  );
}
