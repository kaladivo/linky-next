/**
 * ContactsRepository — the reference repository implementation (issue #15).
 *
 * Demonstrates the conventions from `repository.ts`: a plain TypeScript
 * interface with no Evolu types in its surface, tagged errors instead of
 * throws, and lane routing handled internally by `LinkyStore` (every contact
 * row lands on the `contacts` domain owner lane). The real, full-featured
 * repositories land with #25/#35.
 */
import { createFormatTypeError } from "@evolu/common";

import type { LinkyStore } from "../createLinkyStore";
import { ContactId } from "../schema";
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
  /** All non-deleted contacts, oldest first. */
  readonly list: () => Promise<ReadonlyArray<ContactRecord>>;
}

const formatTypeError = createFormatTypeError();

/** Strips `undefined` entries so "not provided" never overwrites a column. */
const definedEntries = <T extends Record<string, unknown>>(props: T): Partial<T> =>
  Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined)) as Partial<T>;

export const createContactsRepository = (store: LinkyStore): ContactsRepository => {
  const contactsQuery = store.evolu.createQuery((db) =>
    db
      .selectFrom("contact")
      .selectAll()
      .where("isDeleted", "is not", 1)
      .orderBy("createdAt", "asc"),
  );

  const parseId = (id: string): RepoResult<ContactId, InvalidContactIdError> => {
    const parsed = ContactId.fromUnknown(id);
    return parsed.ok ? repoOk(parsed.value) : repoErr({ _tag: "InvalidContactIdError", id });
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

    list: async () => {
      const rows = await store.evolu.loadQuery(contactsQuery);
      return rows.map(
        (row): ContactRecord => ({
          id: String(row.id),
          name: row.name,
          npub: row.npub,
          lnAddress: row.lnAddress,
          groupName: row.groupName,
          archivedAtSec: row.archivedAtSec,
          createdAt: String(row.createdAt),
          updatedAt: row.updatedAt === null ? null : String(row.updatedAt),
        }),
      );
    },
  };
};
