/**
 * Storage rotation controller (#54, `sync.storage-rotation`) — wires the
 * pure decision logic from `@linky/core` (`storageRotation.ts`, see its
 * module doc for the full design) to a `LinkyStore`:
 *
 * - `adoptFromMeta` reads the append-only rotation entries from the synced
 *   `metaEntry` table, resolves the convergent plan (max-merge per domain),
 *   and registers every lane generation 0..index so ALL data — local and
 *   incoming — stays readable. Called at boot and whenever the meta lane
 *   changes (another device rotated).
 * - `rotate` performs one rotation: adopt first (so a concurrently synced
 *   rotation is not repeated), derive the next lane via the injected
 *   `deriveLaneMnemonic` (core's `deriveOwnerLane` closed over the master
 *   secret — the store never sees it), register it as the write lane, and
 *   record the rotation entry under a DETERMINISTIC row id. Two devices
 *   rotating the same domain concurrently therefore upsert the same row —
 *   one rotation, not two.
 * - `maybeAutoRotate` applies core's size-based trigger (write-lane row
 *   count vs threshold + cooldown) per domain.
 * - `inspect` reports the rotation state for the dev debug surface: per
 *   domain the write index and each generation's owner + row count.
 *
 * Data safety: nothing here ever deletes, migrates, or stops syncing a
 * lane; rotation only ADDS a lane and moves future inserts to it. The
 * local-only tables (`_cashuCounter` — NUT-13 counters, fund safety — and
 * `_unknownThread`) are not sync lanes and are never touched.
 */
import { createIdFromString } from "@evolu/common";
import {
  decodeRotationMetaValue,
  encodeRotationMetaValue,
  isRotatingSyncDomain,
  parseRotationMetaKey,
  resolveRotationPlan,
  ROTATION_COOLDOWN_SEC,
  ROTATION_WRITE_THRESHOLDS,
  rotationMetaKey,
  shouldAutoRotate,
} from "@linky/core";
import type { RotatingSyncDomain, RotationPlan } from "@linky/core";

import type { LinkyStore } from "./createLinkyStore";
import { tableSyncDomain } from "./domains";
import type { SyncedTableName } from "./schema";

/** Rotating domains in a stable order (subset of `SYNC_DOMAINS`). */
export const ROTATING_DOMAINS: ReadonlyArray<RotatingSyncDomain> = [
  "contacts",
  "wallet",
  "messages",
  "transactions",
];

/** The synced tables of each rotating domain (reverse of `tableSyncDomain`). */
const tablesOfDomain = (domain: RotatingSyncDomain): ReadonlyArray<SyncedTableName> =>
  (Object.keys(tableSyncDomain) as SyncedTableName[]).filter(
    (table) => tableSyncDomain[table] === domain,
  );

export interface StorageRotationConfig {
  /**
   * Derives the lane mnemonic for (domain, index) — `@linky/core`'s
   * `deriveOwnerLane` closed over the session's master secret. Must be
   * deterministic: every device derives the same lane for the same index.
   */
  readonly deriveLaneMnemonic: (domain: RotatingSyncDomain, index: number) => Promise<string>;
  /** Clock override (tests). Defaults to `Date.now()` seconds. */
  readonly nowSec?: () => number;
  /** Trigger thresholds override (tests). Defaults to core's PoC values. */
  readonly thresholds?: Readonly<Record<RotatingSyncDomain, number>>;
  /** Cooldown override (tests). Defaults to core's value. */
  readonly cooldownSec?: number;
}

/** One generation in the inspector output. */
export interface RotationGenerationInfo {
  readonly index: number;
  readonly ownerId: string;
  /** Rows currently stored on this lane across the domain's tables. */
  readonly rowCount: number;
}

/** Rotation state of one domain (dev inspector / dev panel). */
export interface RotationDomainStatus {
  readonly domain: RotatingSyncDomain;
  /** Current write-lane index. */
  readonly writeIndex: number;
  /** When the write lane was rotated in (unix seconds); null for lane 0. */
  readonly rotatedAtSec: number | null;
  readonly generations: ReadonlyArray<RotationGenerationInfo>;
}

export interface RotateResult {
  readonly domain: RotatingSyncDomain;
  /** The new write-lane index. */
  readonly index: number;
  readonly ownerId: string;
}

export interface StorageRotation {
  /**
   * Adopts the convergent rotation plan from the meta lane: registers every
   * recorded generation so the write lane and the read set match what the
   * account's devices agreed on. Idempotent; returns the adopted plan.
   */
  readonly adoptFromMeta: () => Promise<RotationPlan>;
  /**
   * Rotates one domain to the next lane index (manual/dev or via
   * `maybeAutoRotate`). Adopts first, so it is safe to call concurrently
   * with rotations on other devices — same-target rotations converge to one.
   */
  readonly rotate: (domain: RotatingSyncDomain) => Promise<RotateResult>;
  /**
   * Applies the automatic size-based trigger to every rotating domain;
   * returns the domains that rotated (usually none).
   */
  readonly maybeAutoRotate: () => Promise<ReadonlyArray<RotateResult>>;
  /** Rotation state for the dev inspector. */
  readonly inspect: () => Promise<ReadonlyArray<RotationDomainStatus>>;
  /**
   * Subscribes to changes of the rotation entries (e.g. a rotation synced
   * from another device). Callers typically run `adoptFromMeta` in the
   * listener. Returns the unsubscribe function.
   */
  readonly subscribeRotationEntries: (listener: () => void) => () => void;
}

/** Deterministic `metaEntry` row id of one rotation entry — the convergence key. */
const rotationEntryRowId = (domain: RotatingSyncDomain, index: number) =>
  createIdFromString<"MetaEntry">(`linky-${rotationMetaKey(domain, index)}`);

export const createStorageRotation = (
  store: LinkyStore,
  config: StorageRotationConfig,
): StorageRotation => {
  const nowSec = config.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const thresholds = config.thresholds ?? ROTATION_WRITE_THRESHOLDS;
  const cooldownSec = config.cooldownSec ?? ROTATION_COOLDOWN_SEC;

  // All rotation entries on the meta lane. Deliberately includes soft-deleted
  // rows: a tombstoned entry still proves the lane existed and may hold data,
  // so it must stay in the read set (rotation entries are never deleted by
  // the app anyway).
  const rotationEntriesQuery = store.evolu.createQuery((db) =>
    db
      .selectFrom("metaEntry")
      .selectAll()
      .where("key", "like", "rotation.%" as never),
  );

  const loadRotationEntries = async () => {
    const rows = await store.evolu.loadQuery(rotationEntriesQuery);
    const metaOwnerId = String(store.owners.meta.id);
    return rows
      .filter((row) => String((row as { ownerId?: unknown }).ownerId) === metaOwnerId)
      .map((row) => ({ key: String(row.key), value: row.value }));
  };

  /** Registers lanes 1..index of a domain (lane 0 always exists). */
  const ensureLanesUpTo = async (domain: RotatingSyncDomain, index: number): Promise<void> => {
    const registered = new Set(store.laneGenerations(domain).map((gen) => gen.index));
    for (let lane = 1; lane <= index; lane++) {
      if (registered.has(lane)) continue;
      const mnemonic = await config.deriveLaneMnemonic(domain, lane);
      const result = store.registerRotatedLane(domain, lane, mnemonic);
      if (!result.ok) {
        // deriveLaneMnemonic is deterministic BIP-39 derivation; an invalid
        // mnemonic here is a bug, never user data — fail loudly.
        throw new Error(`registerRotatedLane(${domain}, ${String(lane)}) rejected the mnemonic`);
      }
    }
  };

  const adoptFromMeta = async (): Promise<RotationPlan> => {
    const plan = resolveRotationPlan(await loadRotationEntries());
    for (const domain of ROTATING_DOMAINS) {
      await ensureLanesUpTo(domain, plan[domain].index);
    }
    return plan;
  };

  const rotate = async (domain: RotatingSyncDomain): Promise<RotateResult> => {
    if (!isRotatingSyncDomain(domain)) {
      throw new Error(`Cannot rotate fixed domain "${domain as string}"`);
    }
    const plan = await adoptFromMeta();
    const targetIndex = plan[domain].index + 1;

    const mnemonic = await config.deriveLaneMnemonic(domain, targetIndex);
    const registered = store.registerRotatedLane(domain, targetIndex, mnemonic);
    if (!registered.ok) {
      throw new Error(`registerRotatedLane(${domain}, ${String(targetIndex)}) rejected the mnemonic`);
    }

    // Record the rotation as an append-only entry under a deterministic row
    // id (meta lane; explicit ownerId so the sticky-update path is bypassed —
    // metaEntry lives on the never-rotating meta lane).
    const upserted = store.upsert(
      "metaEntry",
      {
        id: rotationEntryRowId(domain, targetIndex),
        key: rotationMetaKey(domain, targetIndex) as never,
        value: encodeRotationMetaValue({ rotatedAtSec: nowSec() }) as never,
      },
      { ownerId: store.owners.meta.id },
    );
    if (!upserted.ok) {
      // Schema-valid constants cannot fail validation unless the code is wrong.
      throw new Error(`Recording rotation entry for ${domain} failed`);
    }

    return { domain, index: targetIndex, ownerId: String(registered.value.ownerId) };
  };

  const countRowsOnLane = async (domain: RotatingSyncDomain, ownerId: string): Promise<number> => {
    let total = 0;
    for (const table of tablesOfDomain(domain)) {
      const query = store.evolu.createQuery((db) =>
        db
          .selectFrom(table)
          .select("id")
          .where("ownerId" as never, "=", ownerId as never),
      );
      const rows = await store.evolu.loadQuery(query);
      total += rows.length;
    }
    return total;
  };

  const maybeAutoRotate = async (): Promise<ReadonlyArray<RotateResult>> => {
    const plan = await adoptFromMeta();
    const rotated: RotateResult[] = [];
    for (const domain of ROTATING_DOMAINS) {
      const writeLaneRowCount = await countRowsOnLane(
        domain,
        String(store.writeLaneOwnerId(domain)),
      );
      const due = shouldAutoRotate({
        writeLaneRowCount,
        threshold: thresholds[domain],
        nowSec: nowSec(),
        rotatedAtSec: plan[domain].rotatedAtSec,
        cooldownSec,
      });
      if (due) rotated.push(await rotate(domain));
    }
    return rotated;
  };

  const inspect = async (): Promise<ReadonlyArray<RotationDomainStatus>> => {
    const entries = await loadRotationEntries();
    const plan = resolveRotationPlan(entries);
    const rotatedAtByDomainIndex = new Map<string, number | null>();
    for (const entry of entries) {
      const parsed = parseRotationMetaKey(entry.key);
      if (parsed === null) continue;
      rotatedAtByDomainIndex.set(
        `${parsed.domain}.${String(parsed.index)}`,
        decodeRotationMetaValue(entry.value).rotatedAtSec,
      );
    }

    const statuses: RotationDomainStatus[] = [];
    for (const domain of ROTATING_DOMAINS) {
      const generations: RotationGenerationInfo[] = [];
      for (const generation of store.laneGenerations(domain)) {
        generations.push({
          index: generation.index,
          ownerId: String(generation.ownerId),
          rowCount: await countRowsOnLane(domain, String(generation.ownerId)),
        });
      }
      statuses.push({
        domain,
        writeIndex: plan[domain].index,
        rotatedAtSec: plan[domain].rotatedAtSec,
        generations,
      });
    }
    return statuses;
  };

  return {
    adoptFromMeta,
    rotate,
    maybeAutoRotate,
    inspect,
    subscribeRotationEntries: (listener) => store.evolu.subscribeQuery(rotationEntriesQuery)(listener),
  };
};
