/**
 * Imperative session actions (#14): the workflow behind the logout button.
 * Runs the core workflow on the app runtime and invalidates the session
 * version so every mounted `useSession` re-evaluates the boot decision.
 *
 * The #14 dev-only "Create dev identity" scaffold was removed with #17: the
 * real create-account flow (app/onboarding/create.tsx →
 * src/onboarding/onboardingActions.ts `createAccount`) covers the same
 * round-trip, and nothing in scripts/ depended on the dev button.
 */
import { clearIdentitySession, clearLocalProfile } from "@linky/core";

import { unregisterNotificationsOnLogout } from "../notifications/notificationActions";
import { runAppEffect } from "../runtime";
import { teardownStore } from "../store/storeManager";
import { invalidateSession } from "./sessionStore";

/**
 * `identity.logout`: clears local session secrets plus the local profile
 * (#17 — a later account on this device must not inherit the previous
 * user's name/avatar) and tears down the session-scoped Evolu store (#26 —
 * a later account must never read the previous account's data; it boots
 * its own per-identity database). Nothing is deleted remotely — synced
 * data and funds stay recoverable from the backup phrase.
 *
 * Push notifications (#52) unregister FIRST, while the identity secret can
 * still sign the service's NIP-98 unregister proof; the same step clears
 * all local notification state. The identity secret — the only key able to
 * decrypt notification content — is then removed by clearIdentitySession
 * (notifications.md: cleared on logout, never sent to the service).
 * Best-effort by contract: an unreachable push service never blocks logout
 * (the stale row is replaced on the next register or dropped by the
 * service when its token dies).
 */
export const logout = async (): Promise<void> => {
  await unregisterNotificationsOnLogout();
  await runAppEffect(clearIdentitySession);
  await runAppEffect(clearLocalProfile);
  teardownStore();
  invalidateSession();
};
