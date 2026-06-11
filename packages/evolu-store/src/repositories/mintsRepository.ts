/**
 * MintsRepository — known mints + cached NUT-06 info on the `wallet` lane,
 * and the single main-mint preference (issue #35; `mints.*` feature map).
 *
 * ## Where mint data lives (PoC findings, decided here)
 *
 * The PoC has NO mint table in Evolu: mint info rows are device-local
 * localStorage JSON (`linky.local.mintInfo.v1.<ownerId>`, shape
 * `{ url, firstSeenAtSec, lastSeenAtSec, supportsMpp, feesJson, infoJson }`)
 * and the seen-mint list is localStorage too. That made mint metadata
 * unrecoverable on restore. The rewrite promotes mints to a synced
 * `cashuMint` table on the WALLET lane — mints are wallet-domain data (they
 * describe where the wallet's value lives), and cached info/fees/icon are
 * worth syncing so a restored device can render mint names/fees offline.
 * Rows are deduplicated by normalized URL (core `normalizeMintUrl` — same
 * normalization as the counter keys and token rows), enforced here because
 * Evolu has no unique constraints.
 *
 * ## Main-mint preference: `metaEntry`, not a mint-row flag (decided here)
 *
 * The PoC keeps the preference OUTSIDE mint data as a single localStorage
 * value (`linky.cashu.defaultMintOverride.v1` over the env default
 * `MAIN_MINT_URL`). We keep that single-value shape but make it sync: one
 * `metaEntry` row (key `wallet.mainMintUrl.v1`, meta lane). Rationale:
 *
 * - "Single main mint" is an invariant. A per-row `isMain` flag is N
 *   last-writer-wins registers — two devices setting different mains
 *   concurrently converge to TWO flagged rows (or zero on clear races),
 *   and every read needs a tie-break anyway. One key/value row is ONE
 *   register: concurrent writes converge to exactly one winner.
 * - The meta lane is exactly for cross-device coordination values, and the
 *   preference survives wallet-lane storage rotation (#54).
 * - `mints.select-main` contract ("hosted main-mint choice is not persisted
 *   locally if hosted sync failed") stays a flow concern: callers persist
 *   here only after the hosted update succeeded.
 *
 * `getMainMintUrl` returns null when unset — the app falls back to the
 * environment default (`mints.select-main`: per-env default mint), which is
 * config, not storage.
 */
import { createFormatTypeError } from "@evolu/common";

import { normalizeMintUrl } from "@linky/core";

import type { LinkyStore } from "../createLinkyStore";
import type { CashuMintId, MetaEntryId } from "../schema";
import { repoErr, repoOk } from "./repository";
import type { RepoResult } from "./repository";

/** metaEntry key holding the normalized main-mint URL. */
export const MAIN_MINT_META_KEY = "wallet.mainMintUrl.v1";

/** One known mint as core sees it. Plain data, no Evolu types. */
export interface MintRecord {
  readonly id: string;
  /** Normalized mint URL (unique per store). */
  readonly url: string;
  /** Display name from cached NUT-06 info. */
  readonly name: string | null;
  /** Icon URL from cached NUT-06 info. */
  readonly iconUrl: string | null;
  /** Raw NUT-06 info payload, JSON-serialized. */
  readonly infoJson: string | null;
  /** Extracted fee hints, JSON-serialized. */
  readonly feesJson: string | null;
  /** Unix seconds when the cached info was last fetched. */
  readonly infoFetchedAtSec: number | null;
  /** ISO timestamp maintained by the storage layer. */
  readonly createdAt: string;
  /** ISO timestamp maintained by the storage layer; null until the first update. */
  readonly updatedAt: string | null;
}

/** Cached NUT-06 snapshot; `undefined` fields leave the cache untouched. */
export interface MintInfoUpdate {
  readonly name?: string | null;
  readonly iconUrl?: string | null;
  readonly infoJson?: string | null;
  readonly feesJson?: string | null;
  /** Unix seconds of this fetch (`mints.fetch-info` fetchedAt). */
  readonly fetchedAtSec: number;
}

export interface InvalidMintUrlError {
  readonly _tag: "InvalidMintUrlError";
  readonly url: string;
}

export interface MintValidationError {
  readonly _tag: "MintValidationError";
  readonly reason: string;
}

export type MintsRepositoryError = InvalidMintUrlError | MintValidationError;

export interface MintsRepository {
  /**
   * Ensures a row for the (normalized) URL exists — idempotent, one row per
   * URL. Returns the mint id.
   */
  readonly ensure: (url: string) => Promise<RepoResult<{ readonly id: string }, MintsRepositoryError>>;
  /** Stores a fetched NUT-06 snapshot for the mint (creates the row if needed). */
  readonly recordInfo: (
    url: string,
    info: MintInfoUpdate,
  ) => Promise<RepoResult<{ readonly id: string }, MintsRepositoryError>>;
  /** All known (non-removed) mints, by URL. */
  readonly list: () => Promise<ReadonlyArray<MintRecord>>;
  /** The mint with this (normalized) URL, or null. */
  readonly getByUrl: (url: string) => Promise<MintRecord | null>;
  /**
   * Removes a mint (`mints.refresh-delete`): Evolu soft delete, tombstone
   * syncs. Token rows are untouched — removal never implies token deletion
   * (feature-map contract); the main-mint preference is untouched too
   * (changing the main mint is `mints.select-main`'s flow, incl. hosted
   * sync). Idempotent.
   */
  readonly remove: (url: string) => Promise<{ readonly removed: boolean }>;
  /**
   * Persists the main-mint preference (callers run the `mints.select-main`
   * flow — hosted sync first — before calling this).
   */
  readonly setMainMintUrl: (url: string) => Promise<RepoResult<{ readonly url: string }, MintsRepositoryError>>;
  /** The main-mint preference, or null when unset (fall back to env default). */
  readonly getMainMintUrl: () => Promise<string | null>;
}

const formatTypeError = createFormatTypeError();

/** Casts a validated plain value to a branded query-builder value. */
const asParam = (value: string | number): never => value as never;

/** Strips `undefined` entries so "not provided" never overwrites a column. */
const definedEntries = <T extends Record<string, unknown>>(props: T): Partial<T> =>
  Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined)) as Partial<T>;

interface MintRowLike {
  readonly id: unknown;
  readonly url: unknown;
  readonly name: unknown;
  readonly iconUrl: unknown;
  readonly infoJson: unknown;
  readonly feesJson: unknown;
  readonly infoFetchedAtSec: unknown;
  readonly createdAt: unknown;
  readonly updatedAt: unknown;
}

const toMintRecord = (row: MintRowLike): MintRecord => ({
  id: String(row.id),
  url: String(row.url),
  name: row.name === null ? null : String(row.name),
  iconUrl: row.iconUrl === null ? null : String(row.iconUrl),
  infoJson: row.infoJson === null ? null : String(row.infoJson),
  feesJson: row.feesJson === null ? null : String(row.feesJson),
  infoFetchedAtSec: row.infoFetchedAtSec === null ? null : Number(row.infoFetchedAtSec),
  createdAt: String(row.createdAt),
  updatedAt: row.updatedAt === null ? null : String(row.updatedAt),
});

export const createMintsRepository = (store: LinkyStore): MintsRepository => {
  const rowByUrl = async (normalizedUrl: string) => {
    const query = store.evolu.createQuery((db) =>
      db
        .selectFrom("cashuMint")
        .selectAll()
        .where("isDeleted", "is not", 1)
        .where("url", "=", asParam(normalizedUrl))
        .limit(1),
    );
    const rows = await store.evolu.loadQuery(query);
    return rows[0] ?? null;
  };

  const ensure = async (
    url: string,
  ): Promise<RepoResult<{ readonly id: string }, MintsRepositoryError>> => {
    const normalized = normalizeMintUrl(url);
    if (normalized === "") return repoErr({ _tag: "InvalidMintUrlError" as const, url });
    const existing = await rowByUrl(normalized);
    if (existing !== null) return repoOk({ id: String(existing.id) });
    const result = store.insert("cashuMint", { url: normalized });
    if (!result.ok) {
      return repoErr({
        _tag: "MintValidationError" as const,
        reason: formatTypeError(result.error as never),
      });
    }
    return repoOk({ id: String(result.value.id) });
  };

  /** All non-tombstoned metaEntry rows for the main-mint key. */
  const mainMintRows = async () => {
    const query = store.evolu.createQuery((db) =>
      db
        .selectFrom("metaEntry")
        .selectAll()
        .where("isDeleted", "is not", 1)
        .where("key", "=", asParam(MAIN_MINT_META_KEY)),
    );
    return store.evolu.loadQuery(query);
  };

  return {
    ensure,

    recordInfo: async (url, info) => {
      const ensured = await ensure(url);
      if (!ensured.ok) return ensured;
      const result = store.update("cashuMint", {
        id: ensured.value.id as CashuMintId,
        ...definedEntries({
          name: info.name,
          iconUrl: info.iconUrl,
          infoJson: info.infoJson,
          feesJson: info.feesJson,
        }),
        infoFetchedAtSec: info.fetchedAtSec,
      });
      if (!result.ok) {
        return repoErr({
          _tag: "MintValidationError" as const,
          reason: formatTypeError(result.error as never),
        });
      }
      return repoOk({ id: ensured.value.id });
    },

    list: async () => {
      const query = store.evolu.createQuery((db) =>
        db
          .selectFrom("cashuMint")
          .selectAll()
          .where("isDeleted", "is not", 1)
          .orderBy("url", "asc"),
      );
      const rows = await store.evolu.loadQuery(query);
      return rows.map(toMintRecord);
    },

    getByUrl: async (url) => {
      const normalized = normalizeMintUrl(url);
      if (normalized === "") return null;
      const row = await rowByUrl(normalized);
      return row === null ? null : toMintRecord(row);
    },

    remove: async (url) => {
      const normalized = normalizeMintUrl(url);
      if (normalized === "") return { removed: false };
      const existing = await rowByUrl(normalized);
      if (existing === null) return { removed: false };
      store.update("cashuMint", { id: existing.id, isDeleted: 1 });
      return { removed: true };
    },

    setMainMintUrl: async (url) => {
      const normalized = normalizeMintUrl(url);
      if (normalized === "") return repoErr({ _tag: "InvalidMintUrlError" as const, url });
      const rows = await mainMintRows();
      if (rows.length === 0) {
        const result = store.insert("metaEntry", {
          key: MAIN_MINT_META_KEY,
          value: normalized,
        });
        if (!result.ok) {
          return repoErr({
            _tag: "MintValidationError" as const,
            reason: formatTypeError(result.error as never),
          });
        }
        return repoOk({ url: normalized });
      }
      // Duplicates can only appear via concurrent first-writes on two
      // devices; updating every row makes the value converge regardless of
      // which row a reader picks.
      for (const row of rows) {
        store.update("metaEntry", { id: row.id as MetaEntryId, value: normalized });
      }
      return repoOk({ url: normalized });
    },

    getMainMintUrl: async () => {
      const rows = await mainMintRows();
      if (rows.length === 0) return null;
      // Newest write wins (matters only while concurrent duplicates exist).
      const newest = [...rows].sort((a, b) => {
        const aAt = String(a.updatedAt ?? a.createdAt ?? "");
        const bAt = String(b.updatedAt ?? b.createdAt ?? "");
        return aAt < bAt ? 1 : aAt > bAt ? -1 : 0;
      })[0]!;
      return String(newest.value);
    },
  };
};
