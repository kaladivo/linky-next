/**
 * Imperative session actions (#14): the workflows behind the dev
 * "Create dev identity" button and the logout button. Each one runs the
 * core workflow on the app runtime and invalidates the session version so
 * every mounted `useSession` re-evaluates the boot decision.
 *
 * The resolved session values are secrets — callers must not log them; the
 * dev button intentionally ignores the resolved value entirely.
 */
import { clearIdentitySession, createIdentitySession } from "@linky/core";

import { runAppEffect } from "../runtime";
import { invalidateSession } from "./sessionStore";

/**
 * DEV scaffolding for #17: creates and persists a fresh identity so the
 * gate can be exercised before the real onboarding flow exists. The full
 * flow (backup prompt, profile) lands with #17/#18.
 */
export const createDevIdentity = async (): Promise<void> => {
  await runAppEffect(createIdentitySession);
  invalidateSession();
};

/**
 * `identity.logout`: clears local session secrets only. Nothing is deleted
 * remotely — synced data and funds stay recoverable from the backup phrase.
 */
export const logout = async (): Promise<void> => {
  await runAppEffect(clearIdentitySession);
  invalidateSession();
};
