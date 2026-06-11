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

import { runAppEffect } from "../runtime";
import { invalidateSession } from "./sessionStore";

/**
 * `identity.logout`: clears local session secrets plus the local profile
 * (#17 — a later account on this device must not inherit the previous
 * user's name/avatar). Nothing is deleted remotely — synced data and funds
 * stay recoverable from the backup phrase.
 */
export const logout = async (): Promise<void> => {
  await runAppEffect(clearIdentitySession);
  await runAppEffect(clearLocalProfile);
  invalidateSession();
};
