# Nostr Infrastructure

Scope: Relays, profile metadata, publish/retry, inbox sync, and blocked pubkeys.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `nostr.relays` | Relay list | Stores, adds, removes, and displays relay URLs. | Advanced/settings | Connection status is visible; at least one relay is kept. |
| `nostr.probe-relays` | Relay status | Probes relays for connected/checking/disconnected state. | Background/settings | Deferred startup work in PoC. |
| `nostr.publish-relay-lists` | Publish relay lists | Publishes configured relays for external clients. | Relay settings, startup sync | Uses both public relay metadata and DM inbox relay metadata. |
| `nostr.publish-retry` | Publish retry | Retries failed publishes. | Profile/chat/payments | Prevents transient relay failure from losing intent. |
| `nostr.fetch-profile` | Fetch profile | Loads contact metadata and picture. | Contacts/profile | Cached locally. |
| `nostr.publish-profile` | Publish profile | Publishes own metadata. | Profile save/onboarding | Includes `lud16`. |
| `nostr.inbox-sync` | Inbox sync | Syncs wrapped private events. | Chat/background | Drives chat and notification behavior. |
| `nostr.pending-flush` | Pending flush | Sends queued Nostr work when online. | Background | Applies to chat/payment events. |
| `nostr.block-pubkey` | Block pubkey | Prevents unwanted unknown-contact handling. | Unknown chat | Stored locally and published as a mute list when possible. |

## Contracts

- Chat/private events use NIP-17/NIP-59 semantics.
- Relay settings affect external deliverability, not just local connection choice.
- Linky publishes NIP-65 `kind:10002` and NIP-17 DM inbox `kind:10050` relay metadata.
- Relay work must tolerate offline/partial success.
- Blocked pubkeys should not recreate unknown contacts.
- Blocking should merge with existing mute-list `p` tags rather than replacing unrelated blocks.

## Open Questions

- Should relay settings be user-facing in the first mobile release?
- What default relays should mobile use?
