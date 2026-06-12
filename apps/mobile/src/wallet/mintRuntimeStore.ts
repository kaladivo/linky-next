/**
 * In-memory per-mint runtime status (`mints.fetch-info` reachability) —
 * the PoC keeps `lastCheckedAtSec`/`latencyMs` in component state
 * (`useMintInfoStore.getMintRuntime`); here it is a module store so any
 * screen can subscribe via useSyncExternalStore. Deliberately NOT
 * persisted: reachability is a statement about THIS device's network right
 * now, unlike the synced NUT-06 snapshot in the cashuMint table.
 */
import { canonicalizeMintUrl } from "@linky/core";

export type MintRuntimeStatus =
  | { readonly status: "unknown" }
  | { readonly status: "checking" }
  | { readonly status: "reachable"; readonly latencyMs: number; readonly checkedAtSec: number }
  | { readonly status: "unreachable"; readonly checkedAtSec: number };

const UNKNOWN: MintRuntimeStatus = { status: "unknown" };

const runtimeByMint = new Map<string, MintRuntimeStatus>();
let version = 0;
const listeners = new Set<() => void>();

export const subscribeMintRuntime = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Monotone version for useSyncExternalStore snapshots. */
export const getMintRuntimeVersion = (): number => version;

export const getMintRuntime = (mintUrl: string): MintRuntimeStatus =>
  runtimeByMint.get(canonicalizeMintUrl(mintUrl)) ?? UNKNOWN;

export const setMintRuntime = (mintUrl: string, status: MintRuntimeStatus): void => {
  runtimeByMint.set(canonicalizeMintUrl(mintUrl), status);
  version += 1;
  for (const listener of listeners) listener();
};
