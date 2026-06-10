# Nostr Network

Scope: Relays, publishing and retry, inbox sync, profile metadata fetch, and blocked senders.

This is the standard plumbing every Nostr client has. Linky follows common Nostr client conventions here; the notes below capture only what Linky depends on behaviorally.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `nostr.relays` | Relay list | Stores, adds, removes, and displays relay URLs. | Advanced/settings | User-facing as in the PoC (advanced settings). Connection status is visible; at least one relay is always kept. |
| `nostr.probe-relays` | Relay status | Probes relays for connected/checking/disconnected state. | Background/settings | Deferred startup work in PoC. |
| `nostr.publish-relay-lists` | Publish relay lists | Publishes the user's relays so other Nostr clients can reach them. | Relay settings, startup sync | Covers both public relay metadata (NIP-65) and private-message inbox relays (NIP-17). |
| `nostr.publish-retry` | Publish retry | Retries failed publishes. | Profile/chat/payments | Transient relay failure must not lose user intent. |
| `nostr.fetch-profile` | Fetch profile | Loads a contact's metadata and picture. | Contacts/profile | Cached locally. |
| `nostr.publish-profile` | Publish profile | Publishes own metadata. | Profile save, onboarding | Includes `lud16`. |
| `nostr.inbox-sync` | Inbox sync | Syncs wrapped private events. | Chat/background | Drives chat and notification behavior. |
| `nostr.pending-flush` | Pending flush | Sends queued Nostr work when back online. | Background | Applies to chat and payment events. |
| `nostr.block-pubkey` | Block sender | Prevents a blocked sender from reappearing as an unknown contact. | Unknown chat | Stored locally and published as a Nostr mute list when possible. |

## Contracts

- Private events use NIP-17/NIP-59 semantics for interoperability with other clients.
- Relay settings affect whether others can deliver to the user, not just local connectivity.
- Relay work tolerates offline state and partial success.
- Blocked senders do not recreate unknown contacts.
- Publishing a block merges with the user's existing mute list instead of replacing unrelated entries.
- Default relays: `nostr.linky.fit`, `nos.lol`, and `relay.damus.io`.

## Open Questions

- None.
