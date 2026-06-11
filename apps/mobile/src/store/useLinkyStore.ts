/**
 * useLinkyStore — read-only view of the session-scoped store (#26).
 *
 * Pure subscription: booting belongs to the session gate
 * (`app/(tabs)/_layout.tsx` -> `ensureStoreForSession`), teardown to logout.
 * Screens render a loading state while the store is "none"/"creating" —
 * with a loaded session the gate's boot effect always follows.
 */
import { useSyncExternalStore } from "react";

import { getStoreState, subscribeToStore } from "./storeManager";
import type { LinkyStoreState } from "./storeManager";

export const useLinkyStore = (): LinkyStoreState =>
  useSyncExternalStore(subscribeToStore, getStoreState);
