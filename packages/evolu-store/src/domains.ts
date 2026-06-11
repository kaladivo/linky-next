/**
 * Sync-domain separation: which table syncs on which derived owner lane.
 *
 * The lane contract (issue #13): `@linky/core` derives one 12-word BIP-39
 * mnemonic per sync domain from the master secret (`deriveOwnerLane`); this
 * package turns each mnemonic into an Evolu `AppOwner` (SLIP-21 via
 * `@evolu/common`). Same master secret -> same owner ids as the PoC
 * (pinned by `test/__fixtures__/ownerLanes.golden.json`), so a restored
 * account reconnects to every domain's synced data.
 *
 * PoC-compat quirk, kept on purpose: the `identity` lane derives to the SAME
 * owner as `messages` lane 0 (production fallthrough — see
 * `@linky/core` `derivationPaths.ts`). The schema-level domain split still
 * holds (separate tables); only the underlying sync lane is shared.
 */
import { createAppOwner, err, Mnemonic, mnemonicToOwnerSecret, ok } from "@evolu/common";
import type { AppOwner, Result } from "@evolu/common";
import type { SyncDomain } from "@linky/core";

import type { LinkySchema, LocalOnlyTableName, SyncedTableName } from "./schema";

export type { SyncDomain };

/** All six sync domains. Kept in sync with `@linky/core`'s `SyncDomain` literal. */
export const SYNC_DOMAINS = [
  "meta",
  "identity",
  "contacts",
  "wallet",
  "messages",
  "transactions",
] as const satisfies readonly SyncDomain[];

// Compile-time exhaustiveness: every core SyncDomain appears in SYNC_DOMAINS.
type MissingDomains = Exclude<SyncDomain, (typeof SYNC_DOMAINS)[number]>;
type _AssertAllDomainsListed = MissingDomains extends never ? true : never;
const _allDomainsListed: _AssertAllDomainsListed = true;
void _allDomainsListed;

/** One lane mnemonic per sync domain, as derived by `@linky/core`'s `deriveOwnerLane`. */
export type LaneMnemonics = Readonly<Record<SyncDomain, string>>;

/** One Evolu owner per sync domain. */
export type DomainOwners = Readonly<Record<SyncDomain, AppOwner>>;

/** A lane mnemonic was not a valid BIP-39 mnemonic. */
export interface InvalidLaneMnemonicError {
  readonly _tag: "InvalidLaneMnemonicError";
  readonly domain: SyncDomain;
}

/**
 * Turns the six derived lane mnemonics into the six Evolu owners. Pure and
 * deterministic — the heart of restore-reconnect: the same master identity
 * always reconstructs identical owner ids, encryption keys, and write keys.
 */
export const domainOwnersFromLaneMnemonics = (
  laneMnemonics: LaneMnemonics,
): Result<DomainOwners, InvalidLaneMnemonicError> => {
  const owners: Partial<Record<SyncDomain, AppOwner>> = {};
  for (const domain of SYNC_DOMAINS) {
    const parsed = Mnemonic.fromUnknown(laneMnemonics[domain]);
    if (!parsed.ok) return err({ _tag: "InvalidLaneMnemonicError", domain });
    owners[domain] = createAppOwner(mnemonicToOwnerSecret(parsed.value));
  }
  return ok(owners as DomainOwners);
};

/**
 * Table -> sync domain assignment for SYNCED tables. Single source of truth
 * used by `createLinkyStore` to route every mutation to its domain's owner
 * lane. Local-only tables (leading `_`, e.g. `_unknownThread`) are absent on
 * purpose: Evolu applies their mutations outside the sync pipeline and stamps
 * them with the AppOwner (= meta lane owner) id; they never sync anywhere.
 */
export const tableSyncDomain = {
  contact: "contacts",
  blockedSender: "contacts",
  cashuToken: "wallet",
  cashuMint: "wallet",
  message: "messages",
  reaction: "messages",
  transaction: "transactions",
  nostrIdentity: "identity",
  metaEntry: "meta",
} as const satisfies Record<SyncedTableName, SyncDomain>;

export type TableSyncDomain = typeof tableSyncDomain;

// Compile-time exhaustiveness: every schema table is either local-only
// (leading `_`) or has a domain assignment.
type TablesMissingDomain = Exclude<keyof LinkySchema, keyof TableSyncDomain | LocalOnlyTableName>;
type _AssertAllTablesAssigned = TablesMissingDomain extends never ? true : never;
const _allTablesAssigned: _AssertAllTablesAssigned = true;
void _allTablesAssigned;
