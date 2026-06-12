/**
 * Tiny invalidation store for notifications state (#52) — same pattern as
 * sessionStore: screens subscribe to a version that actions bump after
 * persisting, and re-load the state from KeyValueStorage. No state is
 * cached here.
 */
type Listener = () => void;

let version = 0;
const listeners = new Set<Listener>();

export const getNotificationsVersion = (): number => version;

export const subscribeToNotifications = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Call after any action that changed the persisted notifications state. */
export const invalidateNotifications = (): void => {
  version += 1;
  for (const listener of [...listeners]) listener();
};
