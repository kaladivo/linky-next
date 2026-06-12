/**
 * expoNotificationsModule (#52) — the single module that touches the
 * expo-notifications native API. Everything testable (state planning, copy
 * resolution, payload parsing) lives in the pure siblings; this file is
 * deliberately thin glue so unit tests never import the native module.
 *
 * Foreground presentation policy (notifications.closed-app: "an open app
 * suppresses the duplicate alert"):
 * - REMOTE pushes (`type: "nostr_inbox"`, generic copy from the service)
 *   are fully suppressed while the app is foregrounded — the app itself is
 *   the surface (live chat UI + its own rich local notification for
 *   non-open threads).
 * - LOCAL rich notifications the app presents (`type: "linky_chat"`) do
 *   show as banners (they exist only when the app decided to alert).
 * - Anything else (future types, OS notifications) shows by default.
 */
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";

import { appProfile } from "../environment";
import type { PushTokenSource } from "./notificationsState";

/** Remote payload type sent by apps/push (`pushSender.ts` data.type). */
export const REMOTE_INBOX_TYPE = "nostr_inbox";
/** Local rich notification type presented by this app. */
export const LOCAL_CHAT_TYPE = "linky_chat";

export interface NotificationData {
  readonly type: string | null;
  readonly eventId: string | null;
  readonly recipientPubkey: string | null;
  /** Local rich notifications carry the resolved chat route id directly. */
  readonly chatId: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

const fromRecord = (record: Record<string, unknown>): NotificationData => ({
  type: str(record["type"]),
  eventId: str(record["eventId"]),
  recipientPubkey: str(record["recipientPubkey"]),
  chatId: str(record["chatId"]),
});

/**
 * Extracts our data payload from a Notification, covering the shapes that
 * occur in practice: `content.data` (local + Expo-delivered remote), the
 * raw APNs userInfo under `trigger.payload` and Expo's data-under-`body`
 * APNs convention (also what `xcrun simctl push` exercises).
 */
export const dataOfNotification = (
  notification: Notifications.Notification,
): NotificationData => {
  const content = notification.request.content;
  if (isRecord(content.data) && content.data["type"] !== undefined) {
    return fromRecord(content.data);
  }
  const trigger = notification.request.trigger as unknown;
  if (isRecord(trigger) && isRecord(trigger["payload"])) {
    const payload = trigger["payload"];
    if (payload["type"] !== undefined) return fromRecord(payload);
    if (isRecord(payload["body"]) && payload["body"]["type"] !== undefined) {
      return fromRecord(payload["body"]);
    }
  }
  return { type: null, eventId: null, recipientPubkey: null, chatId: null };
};

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export type PermissionState = "granted" | "denied" | "undetermined";

const toPermissionState = (response: Notifications.NotificationPermissionsStatus): PermissionState =>
  response.granted
    ? "granted"
    : response.status === Notifications.PermissionStatus.UNDETERMINED
      ? "undetermined"
      : "denied";

export const getNotificationPermissionState = async (): Promise<PermissionState> =>
  toPermissionState(await Notifications.getPermissionsAsync());

/** Prompts when undetermined; returns the resulting state. */
export const requestNotificationPermission = async (): Promise<PermissionState> => {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return "granted";
  if (!current.canAskAgain && current.status !== Notifications.PermissionStatus.UNDETERMINED) {
    return "denied";
  }
  return toPermissionState(await Notifications.requestPermissionsAsync());
};

// ---------------------------------------------------------------------------
// Expo push token (with the dev-only simulator fallback)
// ---------------------------------------------------------------------------

export interface ObtainedPushToken {
  readonly token: string;
  readonly source: PushTokenSource;
}

/**
 * Obtains the Expo push token for this install.
 *
 * DEV-GATED FALLBACK: simulators have no APNs, and dev builds without an
 * EAS project id cannot mint real Expo tokens — `getExpoPushTokenAsync`
 * rejects. In the development profile ONLY, that failure falls back to a
 * deterministic fake token (`ExponentPushToken[dev-<installationId>]`,
 * matching the service's token schema) so the registration round-trip,
 * replace-stale and the debug screen are fully exercisable against a local
 * service. Real delivery needs a physical device + EAS project (staging/
 * production builds never use the fallback — they surface the error).
 */
export const obtainExpoPushToken = async (
  installationId: string,
): Promise<ObtainedPushToken> => {
  try {
    const projectId: unknown =
      Constants.easConfig?.projectId ??
      (Constants.expoConfig?.extra as Record<string, unknown> | undefined)?.["eas"];
    const response = await Notifications.getExpoPushTokenAsync(
      typeof projectId === "string" ? { projectId } : {},
    );
    return { token: response.data, source: "expo" };
  } catch (error) {
    if (appProfile === "development") {
      return {
        token: `ExponentPushToken[dev-${installationId.slice(0, 32)}]`,
        source: "dev-fake",
      };
    }
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Handlers / listeners
// ---------------------------------------------------------------------------

let handlerInstalled = false;

/** Idempotent: installs the foreground presentation policy (module doc). */
export const installForegroundHandler = (): void => {
  if (handlerInstalled) return;
  handlerInstalled = true;
  Notifications.setNotificationHandler({
    handleNotification: (notification) => {
      const type = dataOfNotification(notification).type;
      const show = type !== REMOTE_INBOX_TYPE;
      return Promise.resolve({
        shouldShowBanner: show,
        shouldShowList: show,
        shouldPlaySound: show,
        shouldSetBadge: false,
      });
    },
  });
};

export const addNotificationReceivedListener = (
  listener: (notification: Notifications.Notification) => void,
): { remove: () => void } => Notifications.addNotificationReceivedListener(listener);

export const addNotificationResponseListener = (
  listener: (response: Notifications.NotificationResponse) => void,
): { remove: () => void } => Notifications.addNotificationResponseReceivedListener(listener);

/** The tap that cold-started the app (null when launched normally). */
export const getLaunchNotificationResponse =
  async (): Promise<Notifications.NotificationResponse | null> => {
    try {
      return await Notifications.getLastNotificationResponseAsync();
    } catch {
      return null;
    }
  };

/** Presents an app-generated rich notification immediately. */
export const presentLocalNotification = async (args: {
  readonly title: string;
  readonly body: string;
  readonly chatId: string;
}): Promise<void> => {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: args.title,
      body: args.body,
      sound: "default",
      data: { type: LOCAL_CHAT_TYPE, chatId: args.chatId },
    },
    trigger: null,
  });
};
