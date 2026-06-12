/**
 * storeManager — the session-scoped Linky Evolu store (#26).
 *
 * Lifecycle (documented in docs/effect-react-bridge.md, "The session-scoped
 * Evolu store"):
 *
 * - The boot gate in `app/(tabs)/_layout.tsx` calls
 *   {@link ensureStoreForSession} as soon as the session loads; every other
 *   consumer only reads through `useLinkyStore()`.
 * - `identity.logout` calls {@link teardownStore} (see
 *   `src/session/sessionActions.ts`): lane sync stops and the reference is
 *   dropped, so no screen can read the previous account's data.
 * - The database NAME is derived from the identity (FNV-1a over the derived
 *   npub, PoC scheme): one SQLite file per identity. A later login with a
 *   DIFFERENT identity gets a different name — a fresh, empty database —
 *   while restoring the SAME identity reattaches to its existing file and
 *   its synced lanes (restore-reconnect).
 * - Evolu 7.4.1 cannot dispose instances (`[Symbol.dispose]` throws) and
 *   caches them per database name. Logout therefore cannot destroy the old
 *   instance; it only stops its lane sync and unhooks it from the app. The
 *   per-identity name guarantees isolation anyway, and re-login to the same
 *   identity intentionally reuses the cached instance.
 *
 * This is app-side session state, NOT a Layer in `appLayer`: the app's one
 * ManagedRuntime is built once per JS context, while the store must be
 * created and torn down per identity. The module mirrors
 * `src/session/sessionStore.ts` — a singleton with subscribe/get for
 * `useSyncExternalStore`.
 */
// MUST stay before any @evolu import: installs crypto.getRandomValues.
import "../../lib/cryptoPolyfill";

import type { OwnerTransport } from "@evolu/common";
import { evoluReactNativeDeps } from "@evolu/react-native/expo-sqlite";
import type { IdentitySession, RotatingSyncDomain } from "@linky/core";
import {
  SyncServerSettingsStore,
  activeSyncServerUrls,
  deriveOwnerLane,
  deriveOwnerLaneMnemonics,
  OwnerLaneIndex,
} from "@linky/core";
import { createLinkyStore, createStorageRotation } from "@linky/evolu-store";
import type { LinkyStore, StorageRotation } from "@linky/evolu-store";
import { Effect } from "effect";

import { runAppEffect } from "../runtime";

export type LinkyStoreState =
  /** No identity has booted a store (logged out, or gate not reached yet). */
  | { readonly status: "none" }
  /** Lane mnemonics are being derived / the instance is being created. */
  | { readonly status: "creating" }
  | {
      readonly status: "ready";
      readonly store: LinkyStore;
      /** Storage rotation controller (#54) bound to this store. */
      readonly rotation: StorageRotation;
    };

type Listener = () => void;

let state: LinkyStoreState = { status: "none" };
/** Identity key of the current/creating store; null when none. */
let currentKey: string | null = null;
let creating: Promise<LinkyStore> | null = null;
/** Unsubscribes the rotation-entry watcher of the current store (#54). */
let unsubscribeRotation: (() => void) | null = null;
const listeners = new Set<Listener>();

const notify = (): void => {
  for (const listener of [...listeners]) listener();
};

const setState = (next: LinkyStoreState): void => {
  state = next;
  notify();
};

export const getStoreState = (): LinkyStoreState => state;

/**
 * Resolves once the session store is ready. For non-React consumers that
 * run AFTER the boot gate mounted (wallet data loads, cashu flows): with a
 * loaded session the gate's `ensureStoreForSession` always follows, so the
 * wait is bounded by store creation. Callers must only run from screens
 * behind the gate — with no identity the promise would never resolve
 * (matching the screens themselves never rendering).
 */
export const getReadyLinkyStore = (): Promise<LinkyStore> => {
  if (state.status === "ready") return Promise.resolve(state.store);
  if (creating !== null) return creating;
  return new Promise((resolve) => {
    const unsubscribe = subscribeToStore(() => {
      if (state.status === "ready") {
        unsubscribe();
        resolve(state.store);
      }
    });
  });
};

export const subscribeToStore = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

// ─── Applied sync servers (#53) ──────────────────────────────────────────
//
// Evolu cannot swap transports on a live instance (and instances cannot be
// disposed), so the list captured at store creation is what actually syncs
// until the next app restart. The sync-server settings screen compares this
// against the current settings to decide whether to show the
// restart-required hint.

let appliedSyncServerUrls: ReadonlyArray<string> | null = null;

/** Sync URLs the current store boot applied; null before any store booted. */
export const getAppliedSyncServerUrls = (): ReadonlyArray<string> | null =>
  appliedSyncServerUrls;

/**
 * FNV-1a over the derived npub -> 8 hex chars (the PoC's db-name scheme).
 * The npub is public material; the hash only namespaces the SQLite file.
 */
export const storeKeyForNpub = (npub: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < npub.length; i++) {
    hash ^= npub.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

/**
 * Boots (or returns) the store for the given identity. Idempotent per
 * identity; a different identity replaces the store (the previous one's
 * lane sync is stopped first). Errors are defects: with a valid session the
 * derivation and store config cannot fail unless the code is wrong.
 */
export const ensureStoreForSession = (session: IdentitySession): Promise<LinkyStore> => {
  const key = storeKeyForNpub(session.nostr.npub);
  if (currentKey === key) {
    if (state.status === "ready") return Promise.resolve(state.store);
    if (creating !== null) return creating;
  }

  // Identity switched without teardown (defense in depth — logout already
  // tears down): stop the previous store's sync before replacing it.
  unsubscribeRotation?.();
  unsubscribeRotation = null;
  if (state.status === "ready") state.store.stopLaneSync();

  currentKey = key;
  setState({ status: "creating" });

  const masterSecret = session.masterIdentity.masterSecret;
  const creatingPair = (async () => {
    const laneMnemonics = await runAppEffect(deriveOwnerLaneMnemonics(masterSecret));
    // The user-edited sync-server list (#53; env defaults when never
    // edited). Evolu 7.4.1 fixes transports at creation and caches the
    // instance per database name, so this snapshot is what THIS app run
    // syncs through — later edits need a restart (the settings screen
    // compares against `getAppliedSyncServerUrls` to show the hint).
    const syncUrls = activeSyncServerUrls(
      await runAppEffect(Effect.flatMap(SyncServerSettingsStore, (store) => store.settings)),
    );
    appliedSyncServerUrls = syncUrls;
    const transports: OwnerTransport[] = syncUrls.map((url) => ({
      type: "WebSocket",
      url,
    }));
    const result = createLinkyStore(evoluReactNativeDeps, {
      name: `linky-${key}`,
      laneMnemonics,
      transports,
    });
    if (!result.ok) {
      // Derived mnemonics + a hex-hash name can only be rejected by a bug.
      throw new Error(`createLinkyStore failed: ${result.error._tag}`);
    }
    const store = result.value;

    // Storage rotation (#54): the controller derives rotated lanes from the
    // session's master secret (deterministic, same lanes on every device).
    const rotation = createStorageRotation(store, {
      deriveLaneMnemonic: async (domain: RotatingSyncDomain, index: number) => {
        const lane = await runAppEffect(
          deriveOwnerLane(masterSecret, domain, OwnerLaneIndex.make(index)),
        );
        return lane.mnemonic;
      },
    });
    // Adopt rotations already recorded locally (local-first: the meta lane's
    // rotation entries are in SQLite) BEFORE any screen writes, so the write
    // lanes match what this account's devices agreed on.
    await rotation.adoptFromMeta();
    return { store, rotation };
  })();
  creating = creatingPair.then((pair) => pair.store);

  void creatingPair.then(
    ({ store, rotation }) => {
      // A teardown/switch may have raced the creation; don't resurrect —
      // and stop the freshly registered lane sync of the orphaned store.
      if (currentKey !== key) {
        store.stopLaneSync();
        return;
      }
      setState({ status: "ready", store, rotation });
      // Re-adopt whenever the rotation entries change (a rotation synced
      // from another device) so this device converges on the same lanes.
      unsubscribeRotation = rotation.subscribeRotationEntries(() => {
        if (currentKey === key) void rotation.adoptFromMeta().catch(() => undefined);
      });
      // Automatic size-based trigger pass on boot; later passes run
      // throttled from invalidateStoreData (after every app-side write).
      void maybeAutoRotate(rotation);
    },
    () => {
      if (currentKey === key) {
        currentKey = null;
        creating = null;
        setState({ status: "none" });
      }
    },
  );

  return creating;
};

// ─── Automatic rotation trigger (#54) ────────────────────────────────────
//
// `sync.storage-rotation` is invisible maintenance: after local writes (and
// once per boot) the size-based trigger runs, rotating any domain whose
// write lane crossed its threshold. Throttled — the real cadence control is
// the threshold + cooldown inside the controller.

const AUTO_ROTATE_THROTTLE_MS = 30_000;
let lastAutoRotateAtMs = 0;
let autoRotateRunning = false;

const maybeAutoRotate = (rotation: StorageRotation): void => {
  if (autoRotateRunning) return;
  const nowMs = Date.now();
  if (nowMs - lastAutoRotateAtMs < AUTO_ROTATE_THROTTLE_MS) return;
  lastAutoRotateAtMs = nowMs;
  autoRotateRunning = true;
  void rotation
    .maybeAutoRotate()
    .catch(() => undefined)
    .finally(() => {
      autoRotateRunning = false;
    });
};

/**
 * `identity.logout`: stops lane sync and unhooks the store. The SQLite file
 * and the cached Evolu instance survive in memory/disk (Evolu cannot
 * dispose yet) but are unreachable from the app; a new identity boots a
 * different database.
 */
export const teardownStore = (): void => {
  unsubscribeRotation?.();
  unsubscribeRotation = null;
  if (state.status === "ready") state.store.stopLaneSync();
  currentKey = null;
  creating = null;
  setState({ status: "none" });
};

// ─── Write invalidation ──────────────────────────────────────────────────
//
// Repository reads are one-shot promises (no Evolu subscriptions cross the
// repository boundary), so screens re-query when this version bumps. Every
// app-side write path (seed, feedback insert, later #27/#28 flows) calls
// `invalidateStoreData()` after mutating.

let dataVersion = 0;
const dataListeners = new Set<Listener>();

export const getStoreDataVersion = (): number => dataVersion;

export const subscribeToStoreData = (listener: Listener): (() => void) => {
  dataListeners.add(listener);
  return () => {
    dataListeners.delete(listener);
  };
};

/** Call after any repository mutation so mounted lists re-query. */
export const invalidateStoreData = (): void => {
  dataVersion += 1;
  for (const listener of [...dataListeners]) listener();
  // Invisible maintenance (#54): writes are the only thing that can push a
  // write lane over its rotation threshold, so check here (throttled).
  if (state.status === "ready") maybeAutoRotate(state.rotation);
};
