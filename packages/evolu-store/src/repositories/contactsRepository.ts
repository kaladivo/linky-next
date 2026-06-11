/**
 * ContactsRepository — address-book persistence on the `contacts` lane
 * (issues #15, #25).
 *
 * The reference repository for the conventions in `repository.ts`: plain
 * TypeScript surface (no Evolu types), tagged errors instead of throws, lane
 * routing handled internally by `LinkyStore`.
 *
 * Groups (`contacts.filter-group`): a contact belongs to at most ONE group,
 * stored as the free-form `groupName` column — exactly the PoC model, where
 * groups exist only as the distinct set of names in use (edit screens
 * suggest from `listGroups`). No separate group table.
 *
 * The contact list (`contacts.list`) pairs each contact with its
 * conversation preview (last message; token previews join in #35+ via the
 * extensible `ConversationPreview` union). Conversations are matched by
 * npub — see the conversation-identity note in `schema.ts`.
 */
import { createFormatTypeError } from "@evolu/common";

import type { LinkyStore } from "../createLinkyStore";
import { ContactId } from "../schema";
import { loadConversationPreviews } from "./messagesRepository";
import type { ConversationPreview } from "./messagesRepository";
import { repoErr, repoOk } from "./repository";
import type { RepoResult } from "./repository";

/** One address-book entry as core sees it. Plain data, no Evolu types. */
export interface ContactRecord {
  readonly id: string;
  readonly name: string | null;
  readonly npub: string | null;
  readonly lnAddress: string | null;
  readonly groupName: string | null;
  /** Unix seconds when archived; null = active. */
  readonly archivedAtSec: number | null;
  /** ISO timestamp maintained by the storage layer. */
  readonly createdAt: string;
  /** ISO timestamp maintained by the storage layer; null until the first update. */
  readonly updatedAt: string | null;
}

export interface NewContact {
  readonly name?: string;
  readonly npub?: string;
  readonly lnAddress?: string;
  readonly groupName?: string;
}

/** Fields settable on update; `null` clears a value, `undefined` leaves it untouched. */
export interface ContactPatch {
  readonly name?: string | null;
  readonly npub?: string | null;
  readonly lnAddress?: string | null;
  readonly groupName?: string | null;
  readonly archivedAtSec?: number | null;
}

/** Contact list filter; every field optional, fields combine (AND). */
export interface ContactFilter {
  /** true = archived only, false = active only, undefined = all. */
  readonly archived?: boolean;
  /** A group name, or `null` for contacts with no group. */
  readonly group?: string | null;
  /** Case-insensitive substring match on name or npub (`contacts.search`). */
  readonly search?: string;
}

/** Contact list item: contact + last conversation preview. */
export interface ContactListItem {
  readonly contact: ContactRecord;
  readonly preview: ConversationPreview | null;
}

/** A contact value failed schema validation (e.g. empty name, string too long). */
export interface ContactValidationError {
  readonly _tag: "ContactValidationError";
  readonly reason: string;
}

/** The given id is not a valid contact id. */
export interface InvalidContactIdError {
  readonly _tag: "InvalidContactIdError";
  readonly id: string;
}

export type ContactsRepositoryError = ContactValidationError | InvalidContactIdError;

export interface ContactsRepository {
  /** Creates a contact; returns its new id. */
  readonly insert: (
    contact: NewContact,
  ) => RepoResult<{ readonly id: string }, ContactValidationError>;
  /** Updates fields of an existing contact. */
  readonly update: (
    id: string,
    patch: ContactPatch,
  ) => RepoResult<{ readonly id: string }, ContactsRepositoryError>;
  /** Soft-deletes a contact (storage keeps the tombstone for sync). */
  readonly remove: (id: string) => RepoResult<{ readonly id: string }, InvalidContactIdError>;
  /** Non-deleted contacts matching the filter, oldest first. */
  readonly list: (filter?: ContactFilter) => Promise<ReadonlyArray<ContactRecord>>;
  /**
   * The contact list with last-message previews (`contacts.list`), ordered
   * by latest conversation activity; contacts without a conversation
   * follow, oldest first.
   */
  readonly listWithPreviews: (filter?: ContactFilter) => Promise<ReadonlyArray<ContactListItem>>;
  /** Distinct group names in use, sorted — group suggestions + filters. */
  readonly listGroups: () => Promise<ReadonlyArray<string>>;
  /** The active contact with this npub, or null (duplicate detection). */
  readonly findByNpub: (npub: string) => Promise<ContactRecord | null>;
}

const formatTypeError = createFormatTypeError();

/** Casts a validated plain value to a branded query-builder value. */
const asParam = (value: string | number): never => value as never;

/** Strips `undefined` entries so "not provided" never overwrites a column. */
const definedEntries = <T extends Record<string, unknown>>(props: T): Partial<T> =>
  Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined)) as Partial<T>;

/** Escapes LIKE wildcards so search input matches literally. */
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (ch) => `\\${ch}`);

interface ContactRowLike {
  readonly id: unknown;
  readonly name: unknown;
  readonly npub: unknown;
  readonly lnAddress: unknown;
  readonly groupName: unknown;
  readonly archivedAtSec: unknown;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
}

const toContactRecord = (row: ContactRowLike): ContactRecord => ({
  id: String(row.id),
  name: row.name === null ? null : String(row.name),
  npub: row.npub === null ? null : String(row.npub),
  lnAddress: row.lnAddress === null ? null : String(row.lnAddress),
  groupName: row.groupName === null ? null : String(row.groupName),
  archivedAtSec: row.archivedAtSec === null ? null : Number(row.archivedAtSec),
  createdAt: String(row.createdAt),
  updatedAt: row.updatedAt === null ? null : String(row.updatedAt),
});

export const createContactsRepository = (store: LinkyStore): ContactsRepository => {
  const filteredQuery = (filter?: ContactFilter) =>
    store.evolu.createQuery((db) => {
      let q = db
        .selectFrom("contact")
        .selectAll()
        .where("isDeleted", "is not", 1)
        .orderBy("createdAt", "asc");
      if (filter?.archived === true) q = q.where("archivedAtSec", "is not", null);
      if (filter?.archived === false) q = q.where("archivedAtSec", "is", null);
      if (filter?.group === null) q = q.where("groupName", "is", null);
      else if (filter?.group !== undefined) q = q.where("groupName", "=", asParam(filter.group));
      if (filter?.search !== undefined && filter.search.length > 0) {
        const pattern = asParam(`%${escapeLike(filter.search)}%`);
        q = q.where((eb) =>
          eb.or([eb("name", "like", pattern), eb("npub", "like", pattern)]),
        );
      }
      return q;
    });

  const parseId = (id: string): RepoResult<ContactId, InvalidContactIdError> => {
    const parsed = ContactId.fromUnknown(id);
    return parsed.ok ? repoOk(parsed.value) : repoErr({ _tag: "InvalidContactIdError", id });
  };

  const list = async (filter?: ContactFilter): Promise<ReadonlyArray<ContactRecord>> => {
    const rows = await store.evolu.loadQuery(filteredQuery(filter));
    return rows.map(toContactRecord);
  };

  return {
    insert: (contact) => {
      const result = store.insert("contact", definedEntries({ ...contact }));
      if (!result.ok) {
        return repoErr({
          _tag: "ContactValidationError",
          reason: formatTypeError(result.error as never),
        });
      }
      return repoOk({ id: String(result.value.id) });
    },

    update: (id, patch) => {
      const parsedId = parseId(id);
      if (!parsedId.ok) return parsedId;
      const result = store.update("contact", {
        id: parsedId.value,
        ...definedEntries({ ...patch }),
      });
      if (!result.ok) {
        return repoErr({
          _tag: "ContactValidationError",
          reason: formatTypeError(result.error as never),
        });
      }
      return repoOk({ id: String(result.value.id) });
    },

    remove: (id) => {
      const parsedId = parseId(id);
      if (!parsedId.ok) return parsedId;
      const result = store.update("contact", { id: parsedId.value, isDeleted: 1 });
      if (!result.ok) {
        // Only the id is validated for a soft delete; an invalid id is the
        // sole expected failure.
        return repoErr({ _tag: "InvalidContactIdError", id });
      }
      return repoOk({ id: String(result.value.id) });
    },

    list,

    listWithPreviews: async (filter) => {
      const contacts = await list(filter);
      const npubs = contacts.flatMap((contact) => (contact.npub === null ? [] : [contact.npub]));
      const previews = await loadConversationPreviews(store, npubs);
      const items = contacts.map(
        (contact): ContactListItem => ({
          contact,
          preview: contact.npub === null ? null : (previews.get(contact.npub) ?? null),
        }),
      );
      // Latest conversation first; contacts without one keep insertion order.
      return items
        .map((item, index) => ({ item, index }))
        .sort((a, b) => {
          const aSec = a.item.preview?.sentAtSec ?? -1;
          const bSec = b.item.preview?.sentAtSec ?? -1;
          return bSec - aSec || a.index - b.index;
        })
        .map(({ item }) => item);
    },

    listGroups: async () => {
      const query = store.evolu.createQuery((db) =>
        db
          .selectFrom("contact")
          .select("groupName")
          .distinct()
          .where("isDeleted", "is not", 1)
          .where("groupName", "is not", null)
          .orderBy("groupName", "asc"),
      );
      const rows = await store.evolu.loadQuery(query);
      return rows.flatMap((row) => (row.groupName === null ? [] : [String(row.groupName)]));
    },

    findByNpub: async (npub) => {
      const query = store.evolu.createQuery((db) =>
        db
          .selectFrom("contact")
          .selectAll()
          .where("isDeleted", "is not", 1)
          .where("npub", "=", asParam(npub))
          .limit(1),
      );
      const rows = await store.evolu.loadQuery(query);
      const row = rows[0];
      return row === undefined ? null : toContactRecord(row);
    },
  };
};
