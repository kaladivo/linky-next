/**
 * Notifications state (#52) — the device-local registration bookkeeping
 * behind `notifications.enable/disable/replace-stale/debug`.
 *
 * What is stored (KeyValueStorage — deliberately NON-secret):
 * - the user's enable choice,
 * - a record of WHAT was last registered with the push service (identity
 *   pubkey, Expo token, service URL, install id) so startup can detect
 *   stale registrations (token rotated, reinstall, identity or service
 *   change) and re-register,
 * - last error / last delivery for the debug screen.
 *
 * NO decryption material lives here. The only key able to decrypt
 * notifications' content is the identity secret in SecureStorage, which
 * `identity.logout` clears (notifications.md contract: "any decryption key
 * kept available for closed-app display stays on the device, is cleared on
 * logout, and is never sent to the service").
 *
 * The install id is stored under its own key and survives logout: it
 * identifies the INSTALL, not the user (PoC parity), and the service caps
 * identities per install — churning ids on every login would hit the cap.
 *
 * Pure planning logic lives here (unit-tested); Expo and HTTP side effects
 * live in notificationActions.ts.
 */
import { KeyValueStorage, Randomness } from "@linky/core";
import { Effect, Encoding, Option } from "effect";

export const NOTIFICATIONS_STATE_STORAGE_KEY = "linky.notifications.state.v1";
export const INSTALLATION_ID_STORAGE_KEY = "linky.notifications.installationId.v1";

/** How the Expo push token was obtained (debug screen + report honesty). */
export type PushTokenSource = "expo" | "dev-fake";

/** What was last successfully registered with the push service. */
export interface PushRegistrationRecord {
  readonly pubkeyHex: string;
  readonly expoPushToken: string;
  readonly tokenSource: PushTokenSource;
  readonly serviceUrl: string;
  readonly installationId: string;
  readonly registeredAtMs: number;
  readonly replacedStaleInstalls: number;
}

/** Last notification that reached this device (debug screen). */
export interface LastDeliveryRecord {
  readonly receivedAtMs: number;
  readonly eventId: string | null;
  /** How it surfaced: suppressed (foreground), tapped, or app-rendered rich. */
  readonly presentation: "remote-foreground" | "remote-tap" | "local-rich";
}

export interface NotificationsState {
  readonly enabled: boolean;
  readonly registration: PushRegistrationRecord | null;
  readonly lastError: string | null;
  readonly lastDelivery: LastDeliveryRecord | null;
}

export const initialNotificationsState: NotificationsState = {
  enabled: false,
  registration: null,
  lastError: null,
  lastDelivery: null,
};

// ---------------------------------------------------------------------------
// (De)serialization — lenient: anything unreadable resets to the initial
// state (worst case the user re-enables; never a crash on corrupt storage).
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export const decodeNotificationsState = (raw: string | null): NotificationsState => {
  if (raw === null) return initialNotificationsState;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return initialNotificationsState;
  }
  if (!isRecord(json)) return initialNotificationsState;

  let registration: PushRegistrationRecord | null = null;
  if (isRecord(json["registration"])) {
    const reg = json["registration"];
    const pubkeyHex = str(reg["pubkeyHex"]);
    const expoPushToken = str(reg["expoPushToken"]);
    const serviceUrl = str(reg["serviceUrl"]);
    const installationId = str(reg["installationId"]);
    if (
      pubkeyHex !== null &&
      expoPushToken !== null &&
      serviceUrl !== null &&
      installationId !== null
    ) {
      registration = {
        pubkeyHex,
        expoPushToken,
        tokenSource: reg["tokenSource"] === "dev-fake" ? "dev-fake" : "expo",
        serviceUrl,
        installationId,
        registeredAtMs: num(reg["registeredAtMs"]) ?? 0,
        replacedStaleInstalls: num(reg["replacedStaleInstalls"]) ?? 0,
      };
    }
  }

  let lastDelivery: LastDeliveryRecord | null = null;
  if (isRecord(json["lastDelivery"])) {
    const delivery = json["lastDelivery"];
    const receivedAtMs = num(delivery["receivedAtMs"]);
    const presentation = delivery["presentation"];
    if (
      receivedAtMs !== null &&
      (presentation === "remote-foreground" ||
        presentation === "remote-tap" ||
        presentation === "local-rich")
    ) {
      lastDelivery = {
        receivedAtMs,
        eventId: str(delivery["eventId"]),
        presentation,
      };
    }
  }

  return {
    enabled: json["enabled"] === true,
    registration,
    lastError: str(json["lastError"]),
    lastDelivery,
  };
};

export const encodeNotificationsState = (state: NotificationsState): string =>
  JSON.stringify(state);

// ---------------------------------------------------------------------------
// Replace-stale planning (notifications.replace-stale) — pure
// ---------------------------------------------------------------------------

/** The credentials a registration depends on, as of right now. */
export interface CurrentRegistrationTarget {
  readonly pubkeyHex: string;
  readonly expoPushToken: string;
  readonly serviceUrl: string;
  readonly installationId: string;
}

export type RegistrationPlan =
  /** Notifications are off — nothing to reconcile. */
  | { readonly _tag: "disabled" }
  /** Registration matches the current credentials — nothing to do. */
  | { readonly _tag: "noop" }
  /** (Re-)register with the service; `reason` explains what went stale. */
  | {
      readonly _tag: "register";
      readonly reason:
        | "initial"
        | "token-changed"
        | "identity-changed"
        | "service-changed"
        | "install-changed";
    };

/**
 * Decides whether the install must (re-)register. Any drift between what
 * was registered and the current credentials re-registers: the service
 * replaces stale state server-side (same install updates in place; other
 * installs holding the same token are removed), so the client never has to
 * delete-then-recreate — except for identity changes, which the key-switch
 * flow handles explicitly while the OLD key can still sign (see
 * notificationActions.handleIdentityChange).
 */
export const planRegistration = (
  state: NotificationsState,
  current: CurrentRegistrationTarget,
): RegistrationPlan => {
  if (!state.enabled) return { _tag: "disabled" };
  const registered = state.registration;
  if (registered === null) return { _tag: "register", reason: "initial" };
  if (registered.pubkeyHex !== current.pubkeyHex) {
    return { _tag: "register", reason: "identity-changed" };
  }
  if (registered.expoPushToken !== current.expoPushToken) {
    return { _tag: "register", reason: "token-changed" };
  }
  if (registered.serviceUrl !== current.serviceUrl) {
    return { _tag: "register", reason: "service-changed" };
  }
  if (registered.installationId !== current.installationId) {
    return { _tag: "register", reason: "install-changed" };
  }
  return { _tag: "noop" };
};

// ---------------------------------------------------------------------------
// Persistence Effects (best-effort, like the other device-local settings)
// ---------------------------------------------------------------------------

export const loadNotificationsState: Effect.Effect<
  NotificationsState,
  never,
  KeyValueStorage.KeyValueStore
> = Effect.gen(function* () {
  const kv = yield* KeyValueStorage.KeyValueStore;
  const raw = yield* kv
    .get(NOTIFICATIONS_STATE_STORAGE_KEY)
    .pipe(Effect.catchAll(() => Effect.succeed(Option.none<string>())));
  return decodeNotificationsState(Option.getOrNull(raw));
}).pipe(Effect.catchAll(() => Effect.succeed(initialNotificationsState)));

export const persistNotificationsState = (
  state: NotificationsState,
): Effect.Effect<void, never, KeyValueStorage.KeyValueStore> =>
  Effect.gen(function* () {
    const kv = yield* KeyValueStorage.KeyValueStore;
    yield* kv.set(NOTIFICATIONS_STATE_STORAGE_KEY, encodeNotificationsState(state));
  }).pipe(Effect.catchAll(() => Effect.void));

/**
 * Stable per-install id (`[A-Za-z0-9._-]{1,128}` per the service schema):
 * 16 CSPRNG bytes, hex. Created once, survives logout (install identity).
 */
export const getOrCreateInstallationId: Effect.Effect<
  string,
  never,
  KeyValueStorage.KeyValueStore | Randomness
> = Effect.gen(function* () {
  const kv = yield* KeyValueStorage.KeyValueStore;
  const existing = yield* kv
    .get(INSTALLATION_ID_STORAGE_KEY)
    .pipe(Effect.catchAll(() => Effect.succeed(Option.none<string>())));
  const stored = Option.getOrElse(existing, () => "").trim();
  if (/^[A-Za-z0-9._-]{1,128}$/.test(stored)) return stored;

  const randomness = yield* Randomness;
  const bytes = yield* randomness.nextBytes(16);
  const id = Encoding.encodeHex(bytes);
  yield* kv.set(INSTALLATION_ID_STORAGE_KEY, id).pipe(Effect.catchAll(() => Effect.void));
  return id;
}).pipe(
  Effect.catchAll(() =>
    // Storage completely broken: fall back to an ephemeral id — registration
    // still works, replace-stale dedupe by token covers the churn.
    Effect.succeed(`ephemeral-${String(Date.now())}`),
  ),
);
