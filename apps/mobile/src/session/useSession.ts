/**
 * useSession — the boot gate's view of the persisted identity (#14).
 *
 * Runs core's `loadSession` on the app runtime and re-runs it whenever a
 * session action (create / logout) invalidates the session version. The
 * discriminated result drives the root gate: `NoIdentity` → onboarding
 * (#17, placeholder for now), `IdentityLoaded` → the normal app.
 */
import type {
  CustomNostrKeyCorruptedError,
  IdentitySessionCorruptedError,
  SecureStorageError,
  SessionState,
} from "@linky/core";
import { loadSession } from "@linky/core";
import { useSyncExternalStore } from "react";

import type { EffectQueryState } from "../runtime";
import { useEffectQuery } from "../runtime";
import { getSessionVersion, subscribeToSessionVersion } from "./sessionStore";

export type SessionQueryState = EffectQueryState<
  SessionState,
  SecureStorageError | IdentitySessionCorruptedError | CustomNostrKeyCorruptedError
>;

export function useSession(): SessionQueryState {
  const version = useSyncExternalStore(subscribeToSessionVersion, getSessionVersion);
  return useEffectQuery(loadSession, [version]);
}
