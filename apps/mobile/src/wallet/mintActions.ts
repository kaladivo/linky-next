/**
 * Mint management actions (#41, `mints.*`): screen data, the
 * select-main flow, info refresh and removal — the seam between the mint
 * screens and core workflows + the #35 store.
 *
 * `mints.select-main` ORDER CONTRACT (feature map): validate → (optional
 * consolidation warning, in the UI) → sync the hosted npub.cash-compatible
 * preference → ONLY THEN persist locally. A failed hosted sync returns
 * before any local write, so the local choice never disagrees with the
 * hosted routing in the dangerous direction.
 */
import type { MintInfoSnapshot } from "@linky/core";
import {
  canonicalizeMintUrl,
  CurrentEnvironment,
  extractPpk,
  fetchMintInfo,
  isTestMintUrl,
  isValidMintUrl,
  loadSession,
  mintBalanceFor,
  mintDisplayName,
  syncHostedMintPreference,
} from "@linky/core";
import type { MintRecord } from "@linky/evolu-store";
import { createMintsRepository, createTokensRepository } from "@linky/evolu-store";
import { Effect, Either } from "effect";

import { runAppEffect } from "../runtime";
import { getReadyLinkyStore, invalidateStoreData } from "../store/storeManager";
import { loadOwnLightningAddress } from "./ownLightningAddress";
import { setMintRuntime } from "./mintRuntimeStore";

/** PoC refresh cadence: re-fetch info older than a day (useMintInfoStore). */
const MINT_INFO_STALE_SEC = 86_400;

export interface MintListEntry {
  /** Canonical mint URL (row identity). */
  readonly url: string;
  /** Short host-based name (PoC display name). */
  readonly displayName: string;
  /** Cached NUT-06 name when known. */
  readonly name: string | null;
  readonly iconUrl: string | null;
  readonly isTest: boolean;
  readonly isMain: boolean;
  readonly isPreset: boolean;
  /** Spendable sat currently sitting on this mint. */
  readonly spendableSat: number;
}

export interface MintsData {
  /** Effective main mint: stored preference or the env default. */
  readonly mainMintUrl: string;
  readonly envDefaultMintUrl: string;
  /** Non-test mints, main first, presets before customs. */
  readonly regularMints: ReadonlyArray<MintListEntry>;
  /** Test mints — rendered visibly separated (`mints.presets`). */
  readonly testMints: ReadonlyArray<MintListEntry>;
}

export interface MintDetail extends MintListEntry {
  /** "ppk: N" style fee hint source — parsed feesJson, or null. */
  readonly feePpk: number | null;
  readonly feesJson: string | null;
  readonly infoFetchedAtSec: number | null;
}

const recordsByUrl = (records: ReadonlyArray<MintRecord>): Map<string, MintRecord> => {
  const map = new Map<string, MintRecord>();
  for (const record of records) map.set(canonicalizeMintUrl(record.url), record);
  return map;
};

interface MintsSnapshot {
  readonly mainMintUrl: string;
  readonly envDefaultMintUrl: string;
  readonly presets: ReadonlyArray<string>;
  readonly known: Map<string, MintRecord>;
  readonly spendableSatOf: (url: string) => number;
}

const loadSnapshot = async (presets: ReadonlyArray<string>, envDefault: string): Promise<MintsSnapshot> => {
  const store = await getReadyLinkyStore();
  const mints = createMintsRepository(store);
  const [records, balances, override] = await Promise.all([
    mints.list(),
    createTokensRepository(store).balances(),
    mints.getMainMintUrl(),
  ]);
  return {
    mainMintUrl: canonicalizeMintUrl(override ?? envDefault),
    envDefaultMintUrl: canonicalizeMintUrl(envDefault),
    presets: presets.map(canonicalizeMintUrl),
    known: recordsByUrl(records),
    spendableSatOf: (url) => mintBalanceFor(balances, url, "sat").spendable,
  };
};

const toEntry = (snapshot: MintsSnapshot, url: string): MintListEntry => {
  const record = snapshot.known.get(url) ?? null;
  return {
    url,
    displayName: mintDisplayName(url),
    name: record?.name ?? null,
    iconUrl: record?.iconUrl ?? null,
    isTest: isTestMintUrl(url),
    isMain: url === snapshot.mainMintUrl,
    isPreset: snapshot.presets.includes(url),
    spendableSat: snapshot.spendableSatOf(url),
  };
};

/** Mints screen data: presets ∪ known rows ∪ the main mint, deduped by
 * canonical URL, split into regular/test groups (`mints.presets`). */
export const loadMintsData: Effect.Effect<MintsData, never, CurrentEnvironment> = Effect.gen(
  function* () {
    const env = yield* CurrentEnvironment;
    const snapshot = yield* Effect.promise(() =>
      loadSnapshot(env.presetMintUrls, env.cashuMintUrl),
    );

    const urls = [
      ...new Set([...snapshot.presets, ...snapshot.known.keys(), snapshot.mainMintUrl]),
    ].filter((url) => url !== "");
    const entries = urls.map((url) => toEntry(snapshot, url));
    const rank = (entry: MintListEntry): number => (entry.isMain ? 0 : entry.isPreset ? 1 : 2);
    const sorted = [...entries].sort(
      (a, b) => rank(a) - rank(b) || a.displayName.localeCompare(b.displayName),
    );

    return {
      mainMintUrl: snapshot.mainMintUrl,
      envDefaultMintUrl: snapshot.envDefaultMintUrl,
      regularMints: sorted.filter((entry) => !entry.isTest),
      testMints: sorted.filter((entry) => entry.isTest),
    };
  },
);

/** Detail-screen data for one mint, or null for an unknown/invalid URL. */
export const loadMintDetail = (
  url: string,
): Effect.Effect<MintDetail | null, never, CurrentEnvironment> =>
  Effect.gen(function* () {
    const canonical = canonicalizeMintUrl(url);
    if (canonical === "" || !isValidMintUrl(canonical)) return null;
    const env = yield* CurrentEnvironment;
    const snapshot = yield* Effect.promise(() =>
      loadSnapshot(env.presetMintUrls, env.cashuMintUrl),
    );
    const entry = toEntry(snapshot, canonical);
    const record = snapshot.known.get(canonical) ?? null;

    let feePpk: number | null = null;
    if (record?.feesJson != null) {
      try {
        feePpk = extractPpk(JSON.parse(record.feesJson));
      } catch {
        feePpk = null;
      }
    }
    return {
      ...entry,
      feePpk,
      feesJson: record?.feesJson ?? null,
      infoFetchedAtSec: record?.infoFetchedAtSec ?? null,
    };
  });

export type SelectMainMintOutcome = "saved" | "invalid" | "sync-failed" | "no-session";

/**
 * The `mints.select-main` flow tail: hosted sync, then local persistence.
 * The UI runs validation + the consolidation warning BEFORE calling this.
 */
export const selectMainMint = async (url: string): Promise<SelectMainMintOutcome> => {
  const canonical = canonicalizeMintUrl(url);
  if (canonical === "" || !isValidMintUrl(canonical)) return "invalid";

  // 1) Hosted preference sync (`mints.sync-hosted`) — must succeed first.
  type HostedSyncOutcome =
    | { readonly kind: "ok"; readonly baseUrl: string }
    | { readonly kind: "no-session" }
    | { readonly kind: "failed"; readonly reason: string };
  let outcome: HostedSyncOutcome;
  try {
    outcome = await runAppEffect(
      Effect.gen(function* () {
        const session = yield* loadSession;
        if (session._tag !== "IdentityLoaded") return { kind: "no-session" } as const;
        const lightningAddress = yield* loadOwnLightningAddress;
        const synced = yield* Effect.either(
          syncHostedMintPreference({
            mintUrl: canonical,
            lightningAddress,
            nostrSecretKey: session.session.activeNostr.identity.secretKey,
          }),
        );
        return Either.match(synced, {
          onLeft: (error): HostedSyncOutcome => ({
            kind: "failed",
            reason: error._tag === "HostedMintSyncError" ? error.reason : error._tag,
          }),
          onRight: (result): HostedSyncOutcome => ({ kind: "ok", baseUrl: result.baseUrl }),
        });
      }),
    );
  } catch (error) {
    outcome = { kind: "failed", reason: String(error) };
  }

  if (outcome.kind === "no-session") return "no-session";
  if (outcome.kind === "failed") {
    console.log(
      `mints.select-main: hosted sync FAILED for ${canonical} (${outcome.reason}) — NOT persisting locally`,
    );
    return "sync-failed";
  }

  // 2) Only now persist the local preference (feature-map contract).
  console.log(
    `mints.select-main: hosted sync ok (${outcome.baseUrl}) for ${canonical} — persisting locally`,
  );
  const store = await getReadyLinkyStore();
  const mints = createMintsRepository(store);
  const ensured = await mints.ensure(canonical);
  if (!ensured.ok) return "invalid";
  const persisted = await mints.setMainMintUrl(canonical);
  if (!persisted.ok) return "invalid";
  invalidateStoreData();

  // Cache info for the new main in the background (best effort).
  void refreshMint(canonical);
  return "saved";
};

export type RefreshMintOutcome = "refreshed" | "unreachable" | "invalid";

/** `mints.refresh-delete` refresh + the `mints.fetch-info` cache write. */
export const refreshMint = async (url: string): Promise<RefreshMintOutcome> => {
  const canonical = canonicalizeMintUrl(url);
  if (canonical === "" || !isValidMintUrl(canonical)) return "invalid";

  setMintRuntime(canonical, { status: "checking" });
  let snapshot: MintInfoSnapshot;
  try {
    snapshot = await runAppEffect(fetchMintInfo(canonical));
  } catch {
    setMintRuntime(canonical, {
      status: "unreachable",
      checkedAtSec: Math.floor(Date.now() / 1000),
    });
    return "unreachable";
  }

  const fetchedAtSec = Math.floor(Date.now() / 1000);
  const store = await getReadyLinkyStore();
  await createMintsRepository(store).recordInfo(canonical, {
    name: snapshot.name,
    iconUrl: snapshot.iconUrl,
    infoJson: snapshot.infoJson,
    feesJson: snapshot.feesJson,
    fetchedAtSec,
  });
  setMintRuntime(canonical, {
    status: "reachable",
    latencyMs: snapshot.latencyMs,
    checkedAtSec: fetchedAtSec,
  });
  invalidateStoreData();
  return "refreshed";
};

// One background-refresh attempt per mint per app session (PoC
// mintInfoCheckOnceRef) — failures may be retried manually via refreshMint.
const refreshedThisSession = new Set<string>();

/** Background info refresh for stale mints (`mints.fetch-info`): never
 * checked, or checked over a day ago. Fire-and-forget from screens. */
export const refreshStaleMints = async (entries: ReadonlyArray<MintListEntry>): Promise<void> => {
  const store = await getReadyLinkyStore();
  const mints = createMintsRepository(store);
  const nowSec = Math.floor(Date.now() / 1000);
  for (const entry of entries) {
    if (refreshedThisSession.has(entry.url)) continue;
    const record = await mints.getByUrl(entry.url);
    const fetchedAt = record?.infoFetchedAtSec ?? 0;
    if (fetchedAt !== 0 && nowSec - fetchedAt < MINT_INFO_STALE_SEC) continue;
    refreshedThisSession.add(entry.url);
    await refreshMint(entry.url);
  }
};

/**
 * `mints.refresh-delete` removal: soft-deletes the mint row only — tokens
 * and the main-mint preference are untouched (feature-map contract). The
 * UI is responsible for the armed confirmation + spendable-funds warning.
 */
export const removeMint = async (url: string): Promise<boolean> => {
  const store = await getReadyLinkyStore();
  const { removed } = await createMintsRepository(store).remove(url);
  if (removed) invalidateStoreData();
  return removed;
};

/** Spendable sat on one mint — the delete flow's "funds not stranded" guard. */
export const spendableSatOnMint = async (url: string): Promise<number> => {
  const store = await getReadyLinkyStore();
  const balances = await createTokensRepository(store).balances();
  return mintBalanceFor(balances, canonicalizeMintUrl(url), "sat").spendable;
};
