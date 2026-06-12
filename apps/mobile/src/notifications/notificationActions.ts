/**
 * Notification actions (#52) — the imperative workflows behind
 * `notifications.enable/disable/replace-stale` and the debug screen.
 *
 * Plain async like the other action modules: screens render returned plain
 * results, Effects run on the app runtime (runAppEffect). Every action
 * persists its outcome into the notifications state (notificationsState.ts)
 * and bumps the notifications version so mounted screens re-read it.
 *
 * Privacy: the registration request carries ONLY pubkey + install id +
 * Expo token (see core's pushRegistration.ts). The identity secret signs
 * the NIP-98 proof in-process and is never stored by this module — the only
 * decryption-capable key stays in SecureStorage and is cleared by logout.
 */
import { loadSession, registerPushInstall, unregisterPushInstall } from "@linky/core";

import { environment } from "../environment";
import { runAppEffect } from "../runtime";
import {
  getNotificationPermissionState,
  obtainExpoPushToken,
  requestNotificationPermission,
} from "./expoNotificationsModule";
import type { PermissionState } from "./expoNotificationsModule";
import {
  getOrCreateInstallationId,
  loadNotificationsState,
  persistNotificationsState,
  planRegistration,
} from "./notificationsState";
import type {
  LastDeliveryRecord,
  NotificationsState,
  PushTokenSource,
} from "./notificationsState";
import { invalidateNotifications } from "./notificationsStore";

const SERVICE_URL = environment.pushServiceUrl;

/** Support-safe error string for the state/debug screen. */
const describeError = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    if (record["_tag"] === "PushRegistrationError") {
      const status = record["status"];
      const code = record["code"];
      const reason = record["reason"];
      return `${typeof status === "number" ? `HTTP ${String(status)} ` : "transport "}${
        typeof code === "string" ? `${code}: ` : ""
      }${typeof reason === "string" ? reason : "request failed"}`;
    }
    if (typeof record["message"] === "string") return record["message"].slice(0, 300);
  }
  return String(error).slice(0, 300);
};

const saveState = async (state: NotificationsState): Promise<void> => {
  await runAppEffect(persistNotificationsState(state));
  invalidateNotifications();
};

interface ActiveIdentity {
  readonly pubkeyHex: string;
  readonly secretKey: Uint8Array;
}

const loadActiveIdentity = async (): Promise<ActiveIdentity | null> => {
  try {
    const session = await runAppEffect(loadSession);
    if (session._tag !== "IdentityLoaded") return null;
    const identity = session.session.activeNostr.identity;
    return { pubkeyHex: identity.publicKeyHex, secretKey: identity.secretKey };
  } catch {
    return null;
  }
};

/** Registers `identity` for this install and persists the success record. */
const registerCurrent = async (args: {
  readonly identity: ActiveIdentity;
  readonly state: NotificationsState;
}): Promise<NotificationsState> => {
  const installationId = await runAppEffect(getOrCreateInstallationId);
  const { token, source } = await obtainExpoPushToken(installationId);
  const result = await runAppEffect(
    registerPushInstall({
      serviceUrl: SERVICE_URL,
      recipientPubkeyHex: args.identity.pubkeyHex,
      secretKey: args.identity.secretKey,
      installationId,
      expoPushToken: token,
    }),
  );
  return {
    ...args.state,
    enabled: true,
    registration: {
      pubkeyHex: args.identity.pubkeyHex,
      expoPushToken: token,
      tokenSource: source,
      serviceUrl: SERVICE_URL,
      installationId,
      registeredAtMs: Date.now(),
      replacedStaleInstalls: result.replacedStaleInstalls,
    },
    lastError: null,
  };
};

// ─── notifications.enable ────────────────────────────────────────────────

export type EnableNotificationsOutcome = "enabled" | "permission-denied" | "no-session" | "failed";

export const enableNotifications = async (): Promise<EnableNotificationsOutcome> => {
  const state = await runAppEffect(loadNotificationsState);

  const permission = await requestNotificationPermission().catch((): PermissionState => "denied");
  if (permission !== "granted") {
    await saveState({ ...state, enabled: false, lastError: "permission denied" });
    return "permission-denied";
  }

  const identity = await loadActiveIdentity();
  if (identity === null) {
    await saveState({ ...state, enabled: false, lastError: "no active identity" });
    return "no-session";
  }

  try {
    await saveState(await registerCurrent({ identity, state }));
    return "enabled";
  } catch (error) {
    await saveState({ ...state, enabled: false, lastError: describeError(error) });
    return "failed";
  }
};

// ─── notifications.disable ───────────────────────────────────────────────

export type DisableNotificationsOutcome = "disabled" | "disabled-server-unreachable";

/**
 * Unregisters this install's identity. The LOCAL disable always applies;
 * a failed server removal is reported (and retried implicitly next time
 * enable runs — registering replaces the stale row anyway).
 */
export const disableNotifications = async (): Promise<DisableNotificationsOutcome> => {
  const state = await runAppEffect(loadNotificationsState);
  const registration = state.registration;
  let serverRemoved = true;

  if (registration !== null) {
    const identity = await loadActiveIdentity();
    if (identity !== null && identity.pubkeyHex === registration.pubkeyHex) {
      try {
        await runAppEffect(
          unregisterPushInstall({
            serviceUrl: registration.serviceUrl,
            recipientPubkeyHex: registration.pubkeyHex,
            secretKey: identity.secretKey,
            installationId: registration.installationId,
          }),
        );
      } catch (error) {
        serverRemoved = false;
        if (__DEV__) console.warn("[notifications] unregister failed:", describeError(error));
      }
    } else {
      // Identity changed/gone — we cannot sign a proof for the stale row.
      serverRemoved = false;
    }
  }

  await saveState({
    ...state,
    enabled: false,
    registration: null,
    lastError: serverRemoved ? null : "server unregister failed (stale row replaced on next enable)",
  });
  return serverRemoved ? "disabled" : "disabled-server-unreachable";
};

// ─── notifications.replace-stale ─────────────────────────────────────────

export type ReconcileOutcome =
  | "disabled"
  | "noop"
  | "re-registered"
  | "no-session"
  | "failed";

/**
 * Startup/background reconciliation: when notifications are enabled,
 * compares the registered credentials with the current ones (token
 * rotation, reinstall with a fresh install id, identity or service change)
 * and re-registers on any drift. The service replaces stale rows — no
 * duplicate or dead registrations survive (`notifications.replace-stale`).
 */
export const reconcileNotificationRegistration = async (): Promise<ReconcileOutcome> => {
  const state = await runAppEffect(loadNotificationsState);
  if (!state.enabled) return "disabled";

  // Permission can be revoked in the OS settings behind our back: treat a
  // non-granted state as "registration is stale and cannot be refreshed".
  const permission = await getNotificationPermissionState().catch(
    (): PermissionState => "denied",
  );
  if (permission !== "granted") {
    await saveState({ ...state, enabled: false, lastError: "permission revoked" });
    return "failed";
  }

  const identity = await loadActiveIdentity();
  if (identity === null) return "no-session";

  try {
    const installationId = await runAppEffect(getOrCreateInstallationId);
    const { token } = await obtainExpoPushToken(installationId);
    const plan = planRegistration(state, {
      pubkeyHex: identity.pubkeyHex,
      expoPushToken: token,
      serviceUrl: SERVICE_URL,
      installationId,
    });
    if (plan._tag === "disabled") return "disabled";
    if (plan._tag === "noop") return "noop";

    if (__DEV__) console.log(`[notifications] re-registering (${plan.reason})`);
    await saveState(await registerCurrent({ identity, state }));
    return "re-registered";
  } catch (error) {
    await saveState({ ...state, lastError: describeError(error) });
    return "failed";
  }
};

// ─── identity switch (#20) ───────────────────────────────────────────────

/**
 * Called by the custom-Nostr-key actions BEFORE the switch is applied, with
 * the OLD identity still loadable: unregisters the old identity from this
 * install (the only moment its proof can still be signed). The caller then
 * switches keys and calls `reconcileNotificationRegistration()` to register
 * the new identity. Best-effort: a failure leaves a stale row the service's
 * token-match replacement cleans up on the next register.
 */
export const unregisterBeforeIdentitySwitch = async (): Promise<void> => {
  const state = await runAppEffect(loadNotificationsState);
  const registration = state.registration;
  if (!state.enabled || registration === null) return;

  const identity = await loadActiveIdentity();
  if (identity === null || identity.pubkeyHex !== registration.pubkeyHex) return;

  try {
    await runAppEffect(
      unregisterPushInstall({
        serviceUrl: registration.serviceUrl,
        recipientPubkeyHex: registration.pubkeyHex,
        secretKey: identity.secretKey,
        installationId: registration.installationId,
      }),
    );
    await saveState({ ...state, registration: null });
  } catch (error) {
    if (__DEV__) {
      console.warn("[notifications] pre-switch unregister failed:", describeError(error));
    }
  }
};

// ─── identity.logout ─────────────────────────────────────────────────────

/**
 * Logout half of the contract: unregister this install's identity while the
 * secret can still sign the proof, then clear ALL local notification state
 * (the enable choice and registration record are per-account). The
 * decryption-capable key itself lives in SecureStorage and is cleared by
 * `clearIdentitySession` right after this runs. Never throws — logout must
 * not be blockable by an unreachable push service.
 */
export const unregisterNotificationsOnLogout = async (): Promise<void> => {
  try {
    const state = await runAppEffect(loadNotificationsState);
    const registration = state.registration;
    if (registration !== null) {
      const identity = await loadActiveIdentity();
      if (identity !== null && identity.pubkeyHex === registration.pubkeyHex) {
        await runAppEffect(
          unregisterPushInstall({
            serviceUrl: registration.serviceUrl,
            recipientPubkeyHex: registration.pubkeyHex,
            secretKey: identity.secretKey,
            installationId: registration.installationId,
          }),
        ).catch(() => undefined);
      }
    }
    await saveState({
      enabled: false,
      registration: null,
      lastError: null,
      lastDelivery: null,
    });
  } catch {
    // Never block logout.
  }
};

// ─── notifications.debug ─────────────────────────────────────────────────

/** Fire-and-forget bookkeeping for the debug screen's "last delivery". */
export const recordNotificationDelivery = (record: LastDeliveryRecord): void => {
  void (async () => {
    const state = await runAppEffect(loadNotificationsState);
    await saveState({ ...state, lastDelivery: record });
  })().catch(() => undefined);
};

export interface NotificationsDebugSnapshot {
  readonly state: NotificationsState;
  readonly permission: PermissionState | "unknown";
  readonly installationId: string;
  readonly serviceUrl: string;
  readonly currentToken: string | null;
  readonly currentTokenSource: PushTokenSource | null;
  readonly health: string;
}

/** Everything the advanced debug screen shows, gathered best-effort. */
export const getNotificationsDebugSnapshot = async (): Promise<NotificationsDebugSnapshot> => {
  const state = await runAppEffect(loadNotificationsState);
  const installationId = await runAppEffect(getOrCreateInstallationId);
  const permission = await getNotificationPermissionState().catch(
    (): PermissionState | "unknown" => "unknown",
  );

  let currentToken: string | null = null;
  let currentTokenSource: PushTokenSource | null = null;
  try {
    const obtained = await obtainExpoPushToken(installationId);
    currentToken = obtained.token;
    currentTokenSource = obtained.source;
  } catch {
    // Real-token path unavailable (no APNs / no EAS project) outside dev.
  }

  const health = await fetchPushServiceHealth();

  return {
    state,
    permission,
    installationId,
    serviceUrl: SERVICE_URL,
    currentToken,
    currentTokenSource,
    health,
  };
};

/** GET /health on the configured service; readable one-liner for the UI. */
const fetchPushServiceHealth = async (): Promise<string> => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const response = await fetch(`${SERVICE_URL}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    const text = await response.text();
    return `HTTP ${String(response.status)} ${text.slice(0, 400)}`;
  } catch (error) {
    return `unreachable: ${describeError(error)}`;
  }
};
