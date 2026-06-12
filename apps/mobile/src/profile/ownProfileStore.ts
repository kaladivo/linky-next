/**
 * Tiny invalidation store for the OWN profile (#30) — same pattern as
 * src/session/sessionStore.ts: `loadOwnProfile` runs through
 * `useEffectQuery`, and this version number is the dep that makes every
 * mounted consumer (profile view, shell-header avatar) re-read after the
 * editor saved. No profile data is cached here.
 */
import { useSyncExternalStore } from "react";

type Listener = () => void;

let version = 0;
const listeners = new Set<Listener>();

export const getOwnProfileVersion = (): number => version;

export const subscribeToOwnProfileVersion = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Call after any workflow that persisted the local profile. */
export const invalidateOwnProfile = (): void => {
  version += 1;
  for (const listener of [...listeners]) listener();
};

/** The current version as a React dep. */
export const useOwnProfileVersion = (): number =>
  useSyncExternalStore(subscribeToOwnProfileVersion, getOwnProfileVersion);
