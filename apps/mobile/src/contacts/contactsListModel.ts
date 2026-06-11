/**
 * contactsListModel — pure list logic for the Contacts tab (#26,
 * `contacts.list` / `contacts.search` / `contacts.filter-group`).
 *
 * No React, no Evolu: takes repository results
 * (`ContactsRepository.listWithPreviews`, `UnknownThreadsRepository.list`)
 * and produces the render model. PoC-matching behaviors pinned by
 * `contactsListModel.test.ts`:
 *
 * - Sections: "Conversations" (rows with chat activity, latest first) and
 *   "Other contacts" (no conversation yet, repository order).
 * - Unknown threads join the conversations section, but only in the "all"
 *   filter (they have no group and never archive; they do match npub
 *   search like the PoC's unknown contacts).
 * - Preview: direction symbol (out ↗ / in ↘) + content truncated to 40
 *   chars; timestamp HH:MM today, DD.MM otherwise (locale-formatted).
 * - Names: a saved contact without a name displays the PoC's deterministic
 *   default name for its npub; unknown threads display the localized
 *   unknown prefix + that default name (display-only, never persisted).
 */
import { deriveDefaultProfile } from "@linky/core";
import type { NameLanguage } from "@linky/core";
import type {
  ContactFilter,
  ContactListItem,
  ConversationPreview,
  UnknownThreadListItem,
} from "@linky/evolu-store";

// ─── Group filter (contacts.filter-group) ────────────────────────────────

/** The chip row: All / No group / Archive / one chip per group name. */
export type GroupFilterSelection =
  | { readonly kind: "all" }
  | { readonly kind: "noGroup" }
  | { readonly kind: "archived" }
  | { readonly kind: "group"; readonly group: string };

/** Stable identity for chips + query deps. */
export const groupFilterKey = (selection: GroupFilterSelection): string =>
  selection.kind === "group" ? `group:${selection.group}` : selection.kind;

/**
 * Maps the chip selection + search box onto the repository filter. Every
 * non-archive chip shows ACTIVE contacts only (PoC: archived contacts are
 * exclusively behind the Archive chip).
 */
export const toContactFilter = (
  selection: GroupFilterSelection,
  search: string,
): ContactFilter => {
  const trimmed = search.trim();
  return {
    archived: selection.kind === "archived",
    ...(selection.kind === "group" ? { group: selection.group } : {}),
    ...(selection.kind === "noGroup" ? { group: null } : {}),
    ...(trimmed.length > 0 ? { search: trimmed } : {}),
  };
};

// ─── Row model ───────────────────────────────────────────────────────────

export interface ContactRowModel {
  readonly key: string;
  readonly kind: "contact" | "unknown";
  /** Route param for chat/[id]: contact id or unknown-thread id. */
  readonly id: string;
  readonly npub: string | null;
  readonly displayName: string;
  readonly preview: ConversationPreview | null;
  /** Unix seconds of the latest activity; null = no conversation. */
  readonly lastActivityAtSec: number | null;
}

export interface ContactListSections {
  /** Rows with chat activity, latest first (contacts + unknown threads). */
  readonly conversations: ReadonlyArray<ContactRowModel>;
  /** Saved contacts without a conversation, repository order. */
  readonly others: ReadonlyArray<ContactRowModel>;
}

/** PoC `formatShortNpub`: `npub1abcde…xyz123`. */
export const shortNpub = (npub: string): string => {
  const trimmed = npub.trim();
  if (trimmed.length <= 18) return trimmed;
  return `${trimmed.slice(0, 10)}…${trimmed.slice(-6)}`;
};

/** Display name for a saved contact (PoC: default name fills the gap). */
export const contactDisplayName = (
  contact: { readonly name: string | null; readonly npub: string | null },
  lang: NameLanguage,
): string => {
  if (contact.name !== null && contact.name.trim().length > 0) return contact.name;
  if (contact.npub !== null) return deriveDefaultProfile(contact.npub, lang).name;
  return "?";
};

/** Display name for an unknown thread: `[Unknown] <default name>`. */
export const unknownThreadDisplayName = (
  npub: string,
  unknownPrefix: string,
  lang: NameLanguage,
): string => `${unknownPrefix} ${deriveDefaultProfile(npub, lang).name}`;

export interface BuildSectionsInput {
  readonly items: ReadonlyArray<ContactListItem>;
  readonly unknownThreads: ReadonlyArray<UnknownThreadListItem>;
  readonly selection: GroupFilterSelection;
  readonly search: string;
  /** Localized `unknownContactNamePrefix`. */
  readonly unknownPrefix: string;
  readonly lang: NameLanguage;
}

/**
 * Builds the two sections. `items` are already repository-filtered
 * (selection + search are applied server-side); unknown threads are
 * filtered here (npub substring vs. search, "all" chip only).
 */
export const buildContactListSections = ({
  items,
  unknownThreads,
  selection,
  search,
  unknownPrefix,
  lang,
}: BuildSectionsInput): ContactListSections => {
  const contactRows = items.map(
    ({ contact, preview }): ContactRowModel => ({
      key: `contact-${contact.id}`,
      kind: "contact",
      id: contact.id,
      npub: contact.npub,
      displayName: contactDisplayName(contact, lang),
      preview,
      lastActivityAtSec: preview?.sentAtSec ?? null,
    }),
  );

  const trimmedSearch = search.trim().toLowerCase();
  const unknownRows =
    selection.kind === "all"
      ? unknownThreads
          .filter(
            ({ thread }) =>
              trimmedSearch.length === 0 || thread.npub.toLowerCase().includes(trimmedSearch),
          )
          .map(
            ({ thread, preview }): ContactRowModel => ({
              key: `unknown-${thread.id}`,
              kind: "unknown",
              id: thread.id,
              npub: thread.npub,
              displayName: unknownThreadDisplayName(thread.npub, unknownPrefix, lang),
              preview,
              lastActivityAtSec: preview?.sentAtSec ?? thread.lastActivityAtSec,
            }),
          )
      : [];

  const conversations = [...contactRows.filter((row) => row.lastActivityAtSec !== null), ...unknownRows]
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        (b.row.lastActivityAtSec ?? 0) - (a.row.lastActivityAtSec ?? 0) || a.index - b.index,
    )
    .map(({ row }) => row);

  return {
    conversations,
    others: contactRows.filter((row) => row.lastActivityAtSec === null),
  };
};

// ─── Preview formatting (PoC ContactCard) ────────────────────────────────

const PREVIEW_MAX_CHARS = 40;

/** `↗ hello` / `↘ hi there…` — direction symbol + 40-char truncation. */
export const formatPreviewText = (preview: ConversationPreview): string => {
  const symbol = preview.direction === "out" ? "↗" : "↘";
  const content = preview.content.trim();
  const truncated =
    content.length > PREVIEW_MAX_CHARS ? `${content.slice(0, PREVIEW_MAX_CHARS)}…` : content;
  return truncated.length > 0 ? `${symbol} ${truncated}` : symbol;
};

/** HH:MM for today, DD.MM otherwise (PoC `formatContactMessageTimestamp`). */
export const formatPreviewTimestamp = (
  sentAtSec: number,
  nowMs: number,
  locale: string,
): string => {
  const ms = sentAtSec * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const date = new Date(ms);
  const now = new Date(nowMs);
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return sameDay
    ? new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date)
    : new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit" }).format(date);
};
