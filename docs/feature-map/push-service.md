# Push Service

Scope: Server-side push subscription API, Nostr relay watcher, and Web Push/FCM delivery.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `push-service.challenge` | Challenge | Issues short-lived ownership challenge. | HTTP API | Per pubkey/action. |
| `push-service.vapid-key` | VAPID key endpoint | Returns current Web Push public key to clients. | HTTP API | Clients re-subscribe when it changes. |
| `push-service.subscribe-web` | Web subscribe | Stores Web Push subscription after proof. | HTTP API | Supports installation id cleanup and pubkey/subscription caps. |
| `push-service.subscribe-native` | Native subscribe | Stores native device token after proof. | HTTP API | Returns unavailable until Firebase service account is configured. |
| `push-service.unsubscribe` | Unsubscribe | Removes pubkeys/subscriptions after proof. | HTTP API | Full removal only when last proven pubkey is removed. |
| `push-service.rate-limit` | Rate limits | Bounds challenge/subscribe/unsubscribe attempts. | HTTP API | Prevents abuse of proof and storage endpoints. |
| `push-service.cors` | CORS allowlist | Restricts browser origins for API access. | HTTP API | Accepts `*` or configured origin list. |
| `push-service.watch-relays` | Relay watcher | Watches relays for outer inbox events. | Background | Uses catch-up window and enables delivery only after EOSE live mode. |
| `push-service.filter-events` | Push event filter | Delivers only valid signed single-recipient `kind:1059` wraps with Linky push marker. | Relay watcher | Keeps self-copies/reactions/normal sync from triggering push. |
| `push-service.dedupe-events` | Event dedupe | Avoids duplicate delivery. | Background | SQLite plus memory cache. |
| `push-service.deliver-web` | Web Push delivery | Sends generic inbox notification payload. | Background | Removes invalid endpoints. |
| `push-service.deliver-native` | FCM delivery | Sends native notification data payload. | Background | Removes invalid tokens. |
| `push-service.health` | Health/build | Exposes health and build version. | HTTP API | Support/ops. |

## Contracts

- Service does not decrypt inbox events.
- Subscribe/unsubscribe requires Nostr ownership proof.
- Delivery payload identifies outer event and recipient pubkey.
- Challenges/proofs are action-specific and expire quickly.
- Relay catch-up must not deliver historical notifications before live mode.
- Native push depends on Firebase config; Web Push depends on VAPID config.
- Storage caps and stale endpoint cleanup prevent duplicate notifications from old installs.

## Open Questions

- Does mobile v1 use this service unchanged, adapted, or replaced?
- Which relays should the service watch by default?
