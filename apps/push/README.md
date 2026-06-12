# @linky/push

Push notification service for Linky's Nostr inbox (`notifications.service-*`
in the [feature map](../../docs/feature-map/notifications.md)). Full rewrite;
the PoC Bun service was behavior reference only.

The service watches Nostr relays for NIP-59 gift wraps (`kind 1059`)
addressed to registered users and sends a **generic** Expo push notification
for each alert-worthy event. It can never read message content:

- it stores only recipient pubkeys, install ids, Expo push tokens, and
  dedupe bookkeeping — no decryption keys, ever;
- the only alert signal is the wrap-level `["linky", "push"]` marker that
  the app's send path puts on recipient wraps of chat messages and payment
  notices. Self/sync copies, reactions, edits, deletions and Cashu token
  messages are sent without the marker and stay quiet;
- rich notification copy (sender, amount, content) is produced on-device by
  the app; the push payload carries only `eventId` + `recipientPubkey`.

## Behavior contract

**Registration (`POST /registrations`)** requires a NIP-98 ownership proof
(see below). One request registers ONE identity (recipient pubkey) on one
install; multi-identity installs register once per identity. Re-registering
replaces stale state instead of duplicating: same identity+install updates
the token in place, and any _other_ install still holding the same device
token (app reinstall) is deleted so one device never gets two pushes.

**Unregister (`DELETE /registrations`)** removes one identity from one
install; the install disappears entirely when its last proven identity is
removed.

**Catch-up after downtime never notifies.** Per relay connection the
watcher REQs `since = now - PUSH_CATCH_UP_LOOKBACK_SEC` (default 3 days —
it must exceed the 2-day NIP-59 `created_at` jitter or relays would
withhold live wraps). "Historical" is defined conservatively and purely by
arrival: anything a relay serves before that connection's EOSE is backfill
and is dropped; only events arriving on the established live subscription
can notify. Event timestamps are never used for freshness (the jitter makes
them meaningless).

**Dedupe** is persistent and two-layered: processed event ids
(`seen_events`, pruned after `PUSH_SEEN_EVENT_RETENTION_MS`) dedupe across
relays and service restarts; `(event id, token)` pairs (`deliveries`)
dedupe across registrations that resolve to the same device token (old +
new installs).

**Abuse limits:** per-IP and per-pubkey fixed-window rate limits on the
registration endpoints, plus hard caps on installs per identity and
identities per install (HTTP 409).

Tokens Expo reports as `DeviceNotRegistered` are dropped from storage.

## Ownership proofs (NIP-98)

`Authorization: Nostr <base64(event)>` — exactly what `@linky/core`'s
`buildNip98Token` produces (kind `27235`):

- `u` tag = `PUSH_PUBLIC_URL` + path (e.g. `https://push.example/registrations`),
- `method` tag = `POST` / `DELETE`,
- `payload` tag = sha256 hex of the **exact raw request body** (send the
  same JSON string you hashed),
- `created_at` within `PUSH_PROOF_MAX_AGE_SEC` (default 60 s) of server
  time, `pubkey` = the `recipientPubkey` in the body.

Proofs are action-specific by construction (URL + method + body hash) and
single-use: consumed event ids are remembered until the window passes, so
replays fail with 401 even inside the validity window.

## API

| Route                   | Body                                                 | Notes                                                                                                                 |
| ----------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `GET /health`           | —                                                    | `{ ok, relays: { [url]: { live, lastLiveEventAtMs } } }`                                                              |
| `POST /registrations`   | `{ recipientPubkey, installationId, expoPushToken }` | NIP-98 proof required. `expoPushToken` must look like `ExponentPushToken[...]`. 200 → `{ ok, replacedStaleInstalls }` |
| `DELETE /registrations` | `{ recipientPubkey, installationId }`                | NIP-98 proof required. 200 → `{ ok, removedIdentity, installRemoved }`                                                |

Errors: `400 invalid_request/invalid_json`, `401 invalid_proof`,
`409 registration_limit`, `413 payload_too_large`, `429 rate_limited`.

## Running

```sh
pnpm --filter @linky/push build
node apps/push/dist/main.js          # or: pnpm --filter @linky/push start
```

Stateless apart from the sqlite file — deploy as a single long-running
process with a persistent volume for `PUSH_DB_PATH`.

### Environment

| Variable                                    | Default                                | Meaning                                                            |
| ------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| `PUSH_PORT`                                 | `8787`                                 | HTTP listen port                                                   |
| `PUSH_PUBLIC_URL`                           | `http://localhost:$PUSH_PORT`          | Public base URL; must match what clients sign in the proof `u` tag |
| `PUSH_DB_PATH`                              | `./data/linky-push.sqlite`             | sqlite file (`:memory:` for ephemeral)                             |
| `PUSH_RELAYS`                               | damus, nos.lol, 0xchat                 | Comma-separated `wss://` relay URLs                                |
| `PUSH_PROOF_MAX_AGE_SEC`                    | `60`                                   | Proof validity window                                              |
| `PUSH_MAX_IDENTITIES_PER_INSTALL`           | `8`                                    | Cap                                                                |
| `PUSH_MAX_INSTALLS_PER_IDENTITY`            | `10`                                   | Cap                                                                |
| `PUSH_RATE_LIMIT_IP_MAX` / `_WINDOW_MS`     | `30` / `60000`                         | Per-IP attempts                                                    |
| `PUSH_RATE_LIMIT_PUBKEY_MAX` / `_WINDOW_MS` | `60` / `3600000`                       | Per-pubkey attempts                                                |
| `PUSH_CATCH_UP_LOOKBACK_SEC`                | `259200` (3 d)                         | REQ `since` window                                                 |
| `PUSH_SEEN_EVENT_RETENTION_MS`              | `604800000` (7 d)                      | Dedupe retention                                                   |
| `PUSH_EXPO_URL`                             | `https://exp.host/--/api/v2/push/send` | Expo push API                                                      |
| `PUSH_EXPO_ACCESS_TOKEN`                    | —                                      | Optional Expo access token                                         |

## Development

```sh
pnpm --filter @linky/push typecheck
pnpm --filter @linky/push lint
pnpm --filter @linky/push test
```

Tests run against an in-memory sqlite database, core's in-memory fake relay
network (`makeFakeRelayNetwork`) and a fake push transport; the integration
suite boots the real HTTP server on an ephemeral port. CI runs all of this
via the repo-wide `pnpm turbo typecheck lint test`.
