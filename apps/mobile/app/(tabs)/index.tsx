/**
 * Contacts tab (#26): the contact list with search, group filter chips and
 * conversation previews — `contacts.list` / `contacts.search` /
 * `contacts.filter-group`.
 *
 * Layout follows the PoC ContactsPage: search bar, chip row (All / No
 * group / Archive / one chip per group), then "Conversations" (rows with
 * chat activity, latest first — unknown threads merge in here exactly like
 * the PoC's unknown contacts, marked with the "?" badge and the localized
 * unknown-name prefix) and "Other contacts" (no conversation yet). Tapping
 * a row pushes chat/[id] (placeholder until #29). The add-contact button
 * routes to the contact/[id] placeholder until #27 lands the real form.
 *
 * Data flows: session gate boots the store (storeManager) ->
 * useLinkyStore() -> useContactsScreenData (repositories) ->
 * buildContactListSections (pure, vitest-covered).
 */
import { Button, Text } from "@linky/ui";
import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";

import { ContactListRow } from "../../src/contacts/ContactListRow";
import { buildContactListSections, groupFilterKey } from "../../src/contacts/contactsListModel";
import type { ContactRowModel, GroupFilterSelection } from "../../src/contacts/contactsListModel";
import { useContactsScreenData } from "../../src/contacts/useContactsScreenData";
import { useLocale } from "../../src/locales";
import { useLinkyStore } from "../../src/store/useLinkyStore";

function FilterChip({
  label,
  active,
  onPress,
  testID,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly onPress: () => void;
  readonly testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      testID={testID}
      className={`rounded-full px-4 py-1.5 ${active ? "bg-primary" : "bg-surface"}`}
    >
      <Text
        weight="semibold"
        className={`text-sm ${active ? "text-primary-foreground" : "text-foreground"}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function SectionHeader({ label }: { readonly label: string }) {
  return (
    <Text weight="semibold" className="pt-2 text-xs uppercase tracking-widest opacity-50">
      {label}
    </Text>
  );
}

export default function ContactsScreen() {
  const { t, locale } = useLocale();
  const router = useRouter();
  const storeState = useLinkyStore();
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<GroupFilterSelection>({ kind: "all" });

  const store = storeState.status === "ready" ? storeState.store : null;
  const data = useContactsScreenData(store, selection, search);

  const sections = useMemo(
    () =>
      data.status === "ready"
        ? buildContactListSections({
            items: data.data.items,
            unknownThreads: data.data.unknownThreads,
            selection,
            search,
            unknownPrefix: t("unknownContactNamePrefix"),
            lang: locale,
          })
        : null,
    [data, groupFilterKey(selection), search, t, locale],
  );

  const openRow = (row: ContactRowModel) => {
    router.push(`/chat/${row.id}`);
  };

  const chips: ReadonlyArray<{ readonly label: string; readonly value: GroupFilterSelection }> = [
    { label: t("all"), value: { kind: "all" } },
    { label: t("noGroup"), value: { kind: "noGroup" } },
    { label: t("archiveFilter"), value: { kind: "archived" } },
    ...(data.status === "ready"
      ? data.data.groups.map((group) => ({
          label: group,
          value: { kind: "group", group } as const,
        }))
      : []),
  ];

  const isEmpty =
    sections !== null && sections.conversations.length === 0 && sections.others.length === 0;
  const isUnfiltered = selection.kind === "all" && search.trim().length === 0;

  return (
    <View className="flex-1 gap-3 bg-background px-6 pt-4">
      <View className="flex-row items-center gap-3">
        <Text weight="bold" className="flex-1 text-2xl">
          {t("contactsTitle")}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("addContact")}
          testID="contacts-add"
          hitSlop={8}
          // #27 lands the real add-contact form; until then the stub routes
          // to the contact detail placeholder.
          onPress={() => router.push("/contact/new")}
          className="h-9 w-9 items-center justify-center rounded-full bg-primary"
        >
          <Text weight="bold" className="text-xl leading-6 text-primary-foreground">
            +
          </Text>
        </Pressable>
      </View>

      <View className="flex-row items-center rounded-xl bg-surface px-4">
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder={t("contactsSearchPlaceholder")}
          placeholderTextColor="#94a3b8"
          autoCapitalize="none"
          autoCorrect={false}
          testID="contacts-search"
          className="flex-1 py-2.5 font-sans text-base text-foreground"
        />
        {search.length > 0 && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("contactsSearchClear")}
            testID="contacts-search-clear"
            hitSlop={8}
            onPress={() => setSearch("")}
          >
            <Text className="text-lg opacity-60">×</Text>
          </Pressable>
        )}
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        className="-mx-6 max-h-10 grow-0"
        contentContainerClassName="gap-2 px-6"
      >
        {chips.map(({ label, value }) => (
          <FilterChip
            key={groupFilterKey(value)}
            label={label}
            active={groupFilterKey(selection) === groupFilterKey(value)}
            onPress={() => setSelection(value)}
            testID={`contacts-filter-${groupFilterKey(value)}`}
          />
        ))}
      </ScrollView>

      {sections === null ? (
        <Text className="pt-4 text-sm opacity-60">{t("loadingMore")}</Text>
      ) : (
        <ScrollView
          className="-mx-2 flex-1 px-2"
          contentContainerClassName="gap-2 pb-6"
          testID="contacts-list"
        >
          {isEmpty ? (
            <View className="gap-3 pt-4">
              <Text className="opacity-70">{t("noContactsYet")}</Text>
              {isUnfiltered && (
                <>
                  <Text className="text-sm opacity-60">{t("contactsEmptyHint")}</Text>
                  <Button
                    label={t("addContact")}
                    variant="primary"
                    testID="contacts-empty-add"
                    onPress={() => router.push("/contact/new")}
                  />
                </>
              )}
            </View>
          ) : (
            <>
              {sections.conversations.length > 0 && (
                <>
                  <SectionHeader label={t("conversations")} />
                  {sections.conversations.map((row) => (
                    <ContactListRow key={row.key} row={row} locale={locale} onPress={openRow} />
                  ))}
                </>
              )}
              {sections.others.length > 0 && (
                <>
                  <SectionHeader label={t("otherContacts")} />
                  {sections.others.map((row) => (
                    <ContactListRow key={row.key} row={row} locale={locale} onPress={openRow} />
                  ))}
                </>
              )}
            </>
          )}
        </ScrollView>
      )}
    </View>
  );
}
