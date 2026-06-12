/**
 * Notification event wiring (#52) — installs the foreground presentation
 * policy and the received/tapped listeners once per JS context (idempotent;
 * called from deferred startup).
 *
 * - Foreground receipt of a service push: suppressed by the handler
 *   (notifications.closed-app — the open app is the surface); recorded for
 *   the debug screen.
 * - Tap (background/closed app, incl. the cold-start launch response):
 *   routed to the right chat via notificationRouting.
 */
import {
  addNotificationReceivedListener,
  addNotificationResponseListener,
  dataOfNotification,
  getLaunchNotificationResponse,
  installForegroundHandler,
  REMOTE_INBOX_TYPE,
} from "./expoNotificationsModule";
import { recordNotificationDelivery } from "./notificationActions";
import { routeForNotificationData } from "./notificationRouting";

let initialized = false;
/** Cold-start taps are delivered once; remember what we already routed. */
let handledLaunchResponseDate: number | null = null;

export const initNotificationEvents = (): void => {
  if (initialized) return;
  initialized = true;

  installForegroundHandler();

  addNotificationReceivedListener((notification) => {
    const data = dataOfNotification(notification);
    if (data.type !== REMOTE_INBOX_TYPE) return;
    recordNotificationDelivery({
      receivedAtMs: Date.now(),
      eventId: data.eventId,
      presentation: "remote-foreground",
    });
  });

  addNotificationResponseListener((response) => {
    handledLaunchResponseDate = response.notification.date;
    const data = dataOfNotification(response.notification);
    recordNotificationDelivery({
      receivedAtMs: Date.now(),
      eventId: data.eventId,
      presentation: "remote-tap",
    });
    void routeForNotificationData(data).catch(() => undefined);
  });

  // Cold start from a tap: the response listener may not have existed yet.
  void getLaunchNotificationResponse()
    .then((response) => {
      if (response === null) return;
      if (handledLaunchResponseDate === response.notification.date) return;
      const data = dataOfNotification(response.notification);
      recordNotificationDelivery({
        receivedAtMs: Date.now(),
        eventId: data.eventId,
        presentation: "remote-tap",
      });
      return routeForNotificationData(data).then(() => undefined);
    })
    .catch(() => undefined);
};
