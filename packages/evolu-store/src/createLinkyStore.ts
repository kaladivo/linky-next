/**
 * The Linky store: one Evolu instance + the six derived domain owner lanes.
 *
 * Lane wiring (issue #15):
 *
 * - The `meta` lane owner boots the instance as `externalAppOwner` — Evolu's
 *   AppOwner is the sync-coordination owner, which is exactly the meta
 *   domain's job. Evolu never generates or stores its own mnemonic.
 * - The other five domain owners are registered with `evolu.useOwner` so
 *   their lanes sync (each lane shares the store transports).
 * - `store.insert/update/upsert` route every mutation to the owner lane of
 *   the table's sync domain (`tableSyncDomain`), so callers cannot land rows
 *   on the wrong lane by forgetting `{ ownerId }`. An explicit
 *   `options.ownerId` still wins (needed later for storage rotation,
 *   `sync.storage-rotation`).
 *
 * `{ ownerId }` mutations and `useOwner` are `@experimental` upstream (Evolu
 * v8 "owner-api" rework). They are wrapped HERE so a future migration stays
 * contained in this package — repositories and core never touch them.
 *
 * Gotcha: `createEvolu` caches instances per database `name`. Creating two
 * stores with the same name in one process returns the same underlying
 * instance (the second config is ignored). Identity switching therefore
 * needs distinct names, exactly like the PoC.
 */
import { err, ok, SimpleName } from "@evolu/common";
import type { EvoluDeps, OwnerId, OwnerTransport, Result, UnuseOwner } from "@evolu/common";
import type { MutationOptions } from "@evolu/common/local-first";

import { createLinkyEvolu } from "./createLinkyEvolu";
import type { LinkyEvolu } from "./createLinkyEvolu";
import { domainOwnersFromLaneMnemonics, SYNC_DOMAINS, tableSyncDomain } from "./domains";
import type { DomainOwners, InvalidLaneMnemonicError, LaneMnemonics } from "./domains";
import { isLocalOnlyTable } from "./schema";
import type { LinkyTableName } from "./schema";

/** The database name was not a valid Evolu `SimpleName` (1-42 chars, alphanumeric + dash). */
export interface InvalidStoreNameError {
  readonly _tag: "InvalidStoreNameError";
  readonly name: string;
}

export type CreateLinkyStoreError = InvalidStoreNameError | InvalidLaneMnemonicError;

export interface LinkyStoreConfig {
  /** Database name; one SQLite file per name (and per identity). */
  readonly name: string;
  /** The six lane mnemonics derived by `@linky/core`'s `deriveOwnerLane`. */
  readonly laneMnemonics: LaneMnemonics;
  /**
   * Relay transports. Defaults to `[]` — a fully local-only store. Local
   * reads and writes never depend on a transport (local-first).
   */
  readonly transports?: ReadonlyArray<OwnerTransport>;
  readonly enableLogging?: boolean;
}

export interface LinkyStore {
  /**
   * The underlying Evolu instance — queries (`createQuery`, `loadQuery`,
   * `subscribeQuery`) go through it directly. For mutations prefer the
   * lane-routed `insert`/`update`/`upsert` below.
   */
  readonly evolu: LinkyEvolu;
  /** The six derived domain owners (meta is also the instance AppOwner). */
  readonly owners: DomainOwners;
  /** The owner lane a table's mutations are routed to. */
  readonly laneOwnerId: (table: LinkyTableName) => OwnerId;
  /** `evolu.insert` routed to the table's domain lane. */
  readonly insert: LinkyEvolu["insert"];
  /** `evolu.update` routed to the table's domain lane. */
  readonly update: LinkyEvolu["update"];
  /** `evolu.upsert` routed to the table's domain lane. */
  readonly upsert: LinkyEvolu["upsert"];
  /**
   * Stops syncing the non-meta lanes (e.g. before switching identities).
   * Local data stays readable; idempotent.
   */
  readonly stopLaneSync: () => void;
}

/**
 * Creates the Linky store from externally derived lane mnemonics.
 *
 * Fails (typed, no throw) when a lane mnemonic is invalid or the database
 * name is not a valid `SimpleName`.
 */
export const createLinkyStore = (
  deps: EvoluDeps,
  config: LinkyStoreConfig,
): Result<LinkyStore, CreateLinkyStoreError> => {
  const name = SimpleName.from(config.name);
  if (!name.ok) return err({ _tag: "InvalidStoreNameError", name: config.name });

  const owners = domainOwnersFromLaneMnemonics(config.laneMnemonics);
  if (!owners.ok) return owners;

  const evolu = createLinkyEvolu(deps, {
    name: name.value,
    transports: config.transports ?? [],
    externalAppOwner: owners.value.meta,
    ...(config.enableLogging === undefined ? {} : { enableLogging: config.enableLogging }),
  });

  // Register every non-meta lane for sync. The meta owner is the AppOwner
  // and syncs by default. AppOwner structurally satisfies SyncOwner (id,
  // encryptionKey, writeKey); without transports each lane falls back to the
  // store transports.
  const unuseOwners: UnuseOwner[] = [];
  for (const domain of SYNC_DOMAINS) {
    if (domain === "meta") continue;
    // `identity` shares the messages-0 owner (PoC fallthrough); registering
    // the same owner twice is fine — Evolu reference-counts transports.
    unuseOwners.push(evolu.useOwner(owners.value[domain]));
  }

  // Local-only tables (leading `_`) bypass the sync pipeline; Evolu stamps
  // their rows with the AppOwner id (= meta lane owner) and ignores any
  // `ownerId` mutation option, so no option is passed for them.
  const laneOwnerId = (table: LinkyTableName): OwnerId =>
    isLocalOnlyTable(table) ? owners.value.meta.id : owners.value[tableSyncDomain[table]].id;

  const withLane = (table: LinkyTableName, options?: MutationOptions): MutationOptions =>
    isLocalOnlyTable(table)
      ? { ...options }
      : {
          ownerId: laneOwnerId(table),
          ...options,
        };

  const insert: LinkyEvolu["insert"] = (table, props, options) =>
    evolu.insert(table, props, withLane(table, options));
  const update: LinkyEvolu["update"] = (table, props, options) =>
    evolu.update(table, props, withLane(table, options));
  const upsert: LinkyEvolu["upsert"] = (table, props, options) =>
    evolu.upsert(table, props, withLane(table, options));

  return ok({
    evolu,
    owners: owners.value,
    laneOwnerId,
    insert,
    update,
    upsert,
    stopLaneSync: () => {
      while (unuseOwners.length > 0) unuseOwners.pop()?.();
    },
  });
};
