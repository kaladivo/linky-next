/**
 * The Linky store: one Evolu instance + the derived domain owner lanes.
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
 *   `options.ownerId` still wins.
 *
 * Storage rotation (issue #54, `sync.storage-rotation`):
 *
 * - A rotating domain (`contacts`, `wallet`, `messages`, `transactions`) can
 *   hold several lane GENERATIONS: lane 0 (the base owner derived at boot)
 *   plus every rotated lane registered via {@link LinkyStore.registerRotatedLane}.
 *   All generations stay registered for sync forever — old data never
 *   becomes unreadable; queries see all generations because Evolu stores
 *   every lane's rows in the same SQLite tables.
 * - INSERTS go to the domain's current WRITE lane (the highest registered
 *   generation) — that is what "moving writes to fresh sync storage" means.
 * - UPDATES/UPSERTS are STICKY: they must land on the lane that already
 *   holds the row. Evolu app tables key rows by `(ownerId, id)` and CRDT
 *   changes never merge across owners, so updating an old-generation row
 *   under the new write lane would create a second, partial row (verified
 *   against Evolu 7.4.1 `applyColumnChange`: `on conflict ("ownerId","id")`).
 *   While a domain has a single generation this is moot and mutations stay
 *   fully synchronous; once it has rotated, update/upsert validate
 *   synchronously (same result contract as Evolu, whose own mutations apply
 *   in a queued microtask anyway) and apply asynchronously on the row's own
 *   lane, resolved by a local lookup. Rows found on several generations
 *   (pre-fix fragmentation) deterministically resolve to the OLDEST
 *   generation, so every device routes the same way. `flushLaneMutations`
 *   awaits the queue (tests, dev tooling).
 * - The rotation DECISION layer (what triggers a rotation, how devices
 *   converge on the same lane index) lives in `rotation.ts` /
 *   `@linky/core`'s `storageRotation` — this module only provides the
 *   mechanics.
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
import { createAppOwner, err, Mnemonic, mnemonicToOwnerSecret, ok, SimpleName } from "@evolu/common";
import type {
  AppOwner,
  EvoluDeps,
  OwnerId,
  OwnerTransport,
  Result,
  UnuseOwner,
} from "@evolu/common";
import type { MutationOptions } from "@evolu/common/local-first";
import { isRotatingSyncDomain } from "@linky/core";
import type { RotatingSyncDomain } from "@linky/core";

import { createLinkyEvolu } from "./createLinkyEvolu";
import type { LinkyEvolu } from "./createLinkyEvolu";
import { domainOwnersFromLaneMnemonics, SYNC_DOMAINS, tableSyncDomain } from "./domains";
import type { DomainOwners, InvalidLaneMnemonicError, LaneMnemonics, SyncDomain } from "./domains";
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
  /** The six lane-0 mnemonics derived by `@linky/core`'s `deriveOwnerLane`. */
  readonly laneMnemonics: LaneMnemonics;
  /**
   * Relay transports. Defaults to `[]` — a fully local-only store. Local
   * reads and writes never depend on a transport (local-first).
   */
  readonly transports?: ReadonlyArray<OwnerTransport>;
  readonly enableLogging?: boolean;
}

/** One registered lane generation of a rotating domain. */
export interface LaneGeneration {
  /** Rotation index (0 = the base lane derived at store creation). */
  readonly index: number;
  /** The Evolu owner id of this generation's lane. */
  readonly ownerId: OwnerId;
}

export interface LinkyStore {
  /**
   * The underlying Evolu instance — queries (`createQuery`, `loadQuery`,
   * `subscribeQuery`) go through it directly. For mutations prefer the
   * lane-routed `insert`/`update`/`upsert` below.
   */
  readonly evolu: LinkyEvolu;
  /** The six base (lane-0) domain owners (meta is also the instance AppOwner). */
  readonly owners: DomainOwners;
  /** The owner lane a table's INSERTS are routed to (the domain's write lane). */
  readonly laneOwnerId: (table: LinkyTableName) => OwnerId;
  /** The current write-lane owner of a sync domain (highest generation). */
  readonly writeLaneOwnerId: (domain: SyncDomain) => OwnerId;
  /**
   * The registered lane generations of a domain, ascending by index. Fixed
   * domains (`meta`, `identity`) always report exactly their base lane.
   */
  readonly laneGenerations: (domain: SyncDomain) => ReadonlyArray<LaneGeneration>;
  /**
   * Registers a rotated lane (#54): the owner derived from `mnemonic` joins
   * the domain's read set (synced like every other lane) and, when `index`
   * is the highest registered, becomes the domain's write lane. Idempotent
   * per (domain, index). The mnemonic must come from `@linky/core`'s
   * `deriveOwnerLane(domain, index)` — the store cannot derive lanes itself
   * (no master secret here). Calling this for a fixed domain or a
   * non-positive index is a programmer error and dies.
   */
  readonly registerRotatedLane: (
    domain: RotatingSyncDomain,
    index: number,
    mnemonic: string,
  ) => Result<LaneGeneration, InvalidLaneMnemonicError>;
  /** `evolu.insert` routed to the table's domain WRITE lane. */
  readonly insert: LinkyEvolu["insert"];
  /**
   * `evolu.update` routed to the lane that holds the row (sticky across
   * rotation generations — see the module doc). Returns the validation
   * result synchronously, like Evolu itself.
   */
  readonly update: LinkyEvolu["update"];
  /** `evolu.upsert` with the same sticky lane routing as `update`. */
  readonly upsert: LinkyEvolu["upsert"];
  /**
   * Resolves when every queued sticky mutation has been applied. Only
   * relevant after a rotation (single-generation domains mutate
   * synchronously); used by tests and the dev rotation surface.
   */
  readonly flushLaneMutations: () => Promise<void>;
  /**
   * Stops syncing the non-meta lanes, including rotated generations (e.g.
   * before switching identities). Local data stays readable; idempotent.
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

  // ─── Lane generations (#54) ────────────────────────────────────────────
  // Rotating domains start with their base lane as generation 0; rotated
  // lanes are appended via registerRotatedLane. Ascending by index; the
  // last entry is the write lane.
  const generations = new Map<RotatingSyncDomain, Array<{ index: number; owner: AppOwner }>>();
  for (const domain of SYNC_DOMAINS) {
    if (isRotatingSyncDomain(domain)) {
      generations.set(domain, [{ index: 0, owner: owners.value[domain] }]);
    }
  }

  const generationsOf = (domain: RotatingSyncDomain) => {
    const gens = generations.get(domain);
    if (gens === undefined) throw new Error(`Unknown rotating domain "${domain}"`);
    return gens;
  };

  const writeLaneOwner = (domain: SyncDomain): AppOwner => {
    if (!isRotatingSyncDomain(domain)) return owners.value[domain];
    const gens = generationsOf(domain);
    return gens[gens.length - 1]!.owner;
  };

  const registerRotatedLane = (
    domain: RotatingSyncDomain,
    index: number,
    mnemonic: string,
  ): Result<LaneGeneration, InvalidLaneMnemonicError> => {
    if (!isRotatingSyncDomain(domain) || !Number.isInteger(index) || index <= 0) {
      // Fixed lanes never rotate and generation 0 always exists — a caller
      // hitting this has a bug, exactly like deriveOwnerLane's guard.
      throw new Error(`registerRotatedLane: invalid lane ${domain}/${String(index)}`);
    }
    const gens = generationsOf(domain);
    const existing = gens.find((generation) => generation.index === index);
    if (existing !== undefined) return ok({ index, ownerId: existing.owner.id });

    const parsed = Mnemonic.fromUnknown(mnemonic);
    if (!parsed.ok) return err({ _tag: "InvalidLaneMnemonicError", domain });
    const owner = createAppOwner(mnemonicToOwnerSecret(parsed.value));
    unuseOwners.push(evolu.useOwner(owner));
    gens.push({ index, owner });
    gens.sort((a, b) => a.index - b.index);
    return ok({ index, ownerId: owner.id });
  };

  // Local-only tables (leading `_`) bypass the sync pipeline; Evolu stamps
  // their rows with the AppOwner id (= meta lane owner) and ignores any
  // `ownerId` mutation option, so no option is passed for them.
  const laneOwnerId = (table: LinkyTableName): OwnerId =>
    isLocalOnlyTable(table) ? owners.value.meta.id : writeLaneOwner(tableSyncDomain[table]).id;

  const insert: LinkyEvolu["insert"] = (table, props, options) =>
    evolu.insert(
      table,
      props,
      isLocalOnlyTable(table) ? { ...options } : { ownerId: laneOwnerId(table), ...options },
    );

  // ─── Sticky update/upsert routing (#54) ─────────────────────────────────
  // Queued FIFO so multiple mutations of the same row apply in call order.
  let laneMutationChain: Promise<void> = Promise.resolve();
  const enqueueLaneMutation = (task: () => Promise<void>): void => {
    laneMutationChain = laneMutationChain.then(task, task);
  };
  const flushLaneMutations = async (): Promise<void> => {
    // Drain until the chain is stable (a flushed task may enqueue nothing,
    // but callers may interleave; two passes cover the common case).
    await laneMutationChain;
    await laneMutationChain;
  };

  /**
   * The lane that holds row `id` of `table`: the OLDEST generation with a
   * row under this id (deterministic across devices), or the current write
   * lane when no generation holds it (brand-new id — upsert-as-insert).
   */
  const resolveRowLane = async (
    table: LinkyTableName,
    domain: RotatingSyncDomain,
    id: string,
  ): Promise<OwnerId> => {
    const query = evolu.createQuery((db) =>
      db
        .selectFrom(table)
        .selectAll()
        .where("id", "=", id as never),
    );
    const rows = await evolu.loadQuery(query);
    const gens = generationsOf(domain);
    const indexByOwner = new Map<string, number>(
      gens.map((generation) => [String(generation.owner.id), generation.index]),
    );
    let best: { index: number; ownerId: OwnerId } | null = null;
    for (const row of rows) {
      const ownerId = (row as { ownerId?: OwnerId }).ownerId;
      if (ownerId === undefined) continue;
      const index = indexByOwner.get(String(ownerId));
      if (index === undefined) continue;
      if (best === null || index < best.index) best = { index, ownerId };
    }
    return best === null ? writeLaneOwner(domain).id : best.ownerId;
  };

  // Loose internal view of Evolu's update/upsert: the public generic typing
  // is restored by the single cast at the end (`as LinkyEvolu["update"]`).
  type LooseMutation = (
    table: LinkyTableName,
    props: Record<string, unknown>,
    options?: MutationOptions,
  ) =>
    | { readonly ok: true; readonly value: { readonly id: unknown } }
    | { readonly ok: false; readonly error: unknown };

  const stickyMutation =
    (kind: "update" | "upsert"): LooseMutation =>
    (table, props, options) => {
      const mutate = evolu[kind] as unknown as LooseMutation;

      if (isLocalOnlyTable(table)) return mutate(table, props, { ...options });
      // Explicit ownerId or validate-only calls keep Evolu's exact semantics.
      if (options?.ownerId !== undefined || options?.onlyValidate === true) {
        return mutate(table, props, options);
      }
      const domain = tableSyncDomain[table];
      if (!isRotatingSyncDomain(domain)) {
        return mutate(table, props, { ownerId: owners.value[domain].id, ...options });
      }
      const gens = generationsOf(domain);
      if (gens.length === 1) {
        // No rotation yet: single lane, fully synchronous (pre-#54 path).
        return mutate(table, props, { ownerId: gens[0]!.owner.id, ...options });
      }

      // Rotated domain: validate now (same Result the caller would get from
      // Evolu), apply on the row's own lane in the FIFO queue. Evolu itself
      // applies mutations in a queued microtask, so the observable contract
      // (sync validation, async application) is unchanged.
      const validation = mutate(table, props, { ...options, onlyValidate: true });
      if (!validation.ok) return validation;
      const id = String((props as { id: unknown }).id);
      enqueueLaneMutation(async () => {
        const ownerId = await resolveRowLane(table, domain, id);
        mutate(table, props, { ...options, ownerId });
        // Evolu submits queued mutations in a microtask; yield one tick so
        // flushLaneMutations callers observe the row after loadQuery.
        await new Promise<void>((resolve) => {
          queueMicrotask(resolve);
        });
      });
      return validation;
    };

  const update = stickyMutation("update") as unknown as LinkyEvolu["update"];
  const upsert = stickyMutation("upsert") as unknown as LinkyEvolu["upsert"];

  return ok({
    evolu,
    owners: owners.value,
    laneOwnerId,
    writeLaneOwnerId: (domain) => writeLaneOwner(domain).id,
    laneGenerations: (domain) =>
      isRotatingSyncDomain(domain)
        ? generationsOf(domain).map(({ index, owner }) => ({ index, ownerId: owner.id }))
        : [{ index: 0, ownerId: owners.value[domain].id }],
    registerRotatedLane,
    insert,
    update,
    upsert,
    flushLaneMutations,
    stopLaneSync: () => {
      while (unuseOwners.length > 0) unuseOwners.pop()?.();
    },
  });
};
