/**
 * Tiny invalidation store for the boot session (#14).
 *
 * `loadSession` runs through `useEffectQuery`, which re-executes when its
 * deps change; this module provides the dep: a version number bumped by
 * every action that changes what is persisted (create identity, logout).
 * No session data is cached here — secrets stay inside the Effect workflows
 * and the query state of the mounted hook.
 */
type Listener = () => void;

let version = 0;
const listeners = new Set<Listener>();

export const getSessionVersion = (): number => version;

export const subscribeToSessionVersion = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Call after any workflow that persisted or cleared the identity. */
export const invalidateSession = (): void => {
  version += 1;
  for (const listener of [...listeners]) listener();
};
