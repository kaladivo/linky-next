# Notifications

Scope: Alerting users about new messages and payments, including while the app is closed, and the notification service behavior that supports it.

Supporting layer for both pillars: messenger events ("new message") and wallet events ("you got paid") share one delivery path. Notifications are first-release behavior. The PoC notification service is throwaway; the rewrite builds a replacement, keeping the behaviors below.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `notifications.enable` | Enable notifications | Asks for permission and registers this install for delivery. | Settings, startup | Registration proves ownership of the user's Nostr identity. |
| `notifications.disable` | Disable notifications | Unregisters this install. | Settings | Full removal only when the last proven identity is removed. |
| `notifications.replace-stale` | Replace stale registrations | Re-registers when delivery credentials change and cleans up old installs. | Startup, background | Prevents broken or duplicate notifications after reinstall or key change. |
| `notifications.notify-message` | Message notification | Alerts on a new private message. | Incoming message | Shows sender/content when on-device decryption is possible; falls back to generic copy otherwise. |
| `notifications.notify-payment` | Payment notification | Uses payment-specific copy for incoming payments. | Incoming payment | Shows sender/amount when on-device decryption is possible; falls back to generic copy. The token message itself stays quiet; the separate payment notice triggers the alert. |
| `notifications.closed-app` | Closed-app delivery | Delivers notifications while the app is not running. | Background | An open app suppresses the duplicate alert. |
| `notifications.service-watch` | Service relay watching | The service watches Nostr relays for events addressed to registered users. | Service | Catch-up after downtime must not deliver historical notifications. |
| `notifications.service-filter` | Service event filter | Delivers only valid private events marked for notification. | Service | Keeps self-copies, reactions, and normal sync traffic from triggering alerts. |
| `notifications.dedupe` | Delivery dedupe | Prevents duplicate notifications for one event. | Service, app | Includes duplicates across old and new installs. |
| `notifications.abuse-limits` | Abuse limits | Bounds registration attempts and per-user registrations. | Service | Protects the proof and storage endpoints. |
| `notifications.debug` | Notification debug | Shows registration and delivery state. | Advanced debug | Dev/support only. |

## Contracts

- Registering requires proving ownership of the recipient's Nostr identity; proofs are action-specific and expire quickly.
- The notification service never decrypts private messages; it sees only encrypted events and the recipient identity.
- Cashu token messages and payment notice events have different notification roles.
- Any decryption key kept available for closed-app display stays on the device, is cleared on logout, and is never sent to the service.
- Registration changes replace stale registrations instead of duplicating them.
- Rich notification copy (sender, amount, content) appears only when decryption happens on the device; anything the service cannot prove decryptable falls back to generic copy.

## Open Questions

- None.
