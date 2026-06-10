# Push Notifications

Scope: Client notification registration, service-worker/native push behavior, and notification display rules.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `push.request-permission` | Permission | Requests notification permission. | Settings/startup | Native and web differ. |
| `push.register-web` | Web push registration | Registers browser subscription. | Settings/background | Uses ownership proof. |
| `push.register-native` | Native registration | Registers native device token. | Settings/background | Android FCM exists in PoC. |
| `push.unregister` | Unregister | Removes stale/current subscriptions. | Settings/background | Cleans rotated endpoints. |
| `push.vapid-rotation` | VAPID rotation handling | Validates subscription key against server key and re-subscribes on mismatch. | Startup, SW events | Prevents broken or duplicate browser push after key changes. |
| `push.installation-id` | Installation identity | Persists stable installation id and last registered endpoint/token. | Registration | Lets server replace stale installs and cleanup legacy rows. |
| `push.sw-secret-mirror` | Service-worker decrypt key | Mirrors active `nsec` into IndexedDB for closed-app local decrypt. | Login/logout/startup | Cleared on logout; never sent to push service. |
| `push.notify-message` | Message notification | Shows generic inbox notification. | Push event | Closed-app path may decrypt locally in SW. |
| `push.notify-payment` | Payment notification | Uses payment-specific copy. | Push event | Token chat messages stay quiet; notice triggers alert. |
| `push.native-data-only` | Native data push | Android receives data-only FCM and renders notification locally when app is closed. | Native push | Foreground app suppresses native shell notification. |
| `push.debug` | Push debug | Shows subscription/SW/cache/log state. | Advanced debug | Dev/support feature. |

## Contracts

- Subscription registration proves ownership of recipient pubkeys.
- Open app clients suppress duplicate service-worker notifications.
- Cashu token messages and payment notice events have different notification roles.
- Service-worker local decrypt requires the browser-stored `nsec`; it must be cleared on logout and never leave the client.
- Push subscription changes should trigger re-registration rather than leaving stale endpoints active.

## Open Questions

- Is push part of first mobile release?
- Does Expo mobile need the same push service contract as the PoC?
