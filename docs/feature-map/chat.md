# Chat

Scope: Private Nostr messaging, message state, reactions, edits, replies, deletes, and retention.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `chat.send-message` | Send message | Sends private text to a contact. | Chat | Optimistic pending state. |
| `chat.receive-message` | Receive message | Syncs private messages from relays. | Chat, inbox sync | Unknown senders create unknown contacts. |
| `chat.reply` | Reply | Attaches reply/root context. | Message actions | Uses message ids where available. |
| `chat.edit-message` | Edit | Sends edit for own text message. | Message actions | Original content is preserved locally. |
| `chat.react` | React | Sends emoji reaction and aggregates latest per reactor. | Message actions | One visible reaction per user. |
| `chat.delete` | Delete handling | Applies delete events to messages/reactions. | Sync | Needs dedupe by wrap ids. |
| `chat.pending-ack` | Pending ack | Reconciles optimistic messages with relay echoes. | Sync | Uses client tag/rumor id/content fallback. |
| `chat.retention` | Retention | Caps stored messages/reactions. | Background | PoC caps latest 500/contact, 3000 global, 5000 reactions. |

## Flows

- `chat.receive-message`: subscribe/fetch NIP-17 wraps, unwrap, validate peer, dedupe, store message/reaction/delete.
- `chat.pending-ack`: send local pending message, later mark sent from matching wrapped event.

## Contracts

- Chat uses NIP-17/NIP-59 gift-wrapped messages.
- Nested encrypted payloads and invalid inner/wrap pubkey cases are ignored.
- Identity switch time can filter out older events for custom-key mode.
- Message history must not duplicate relay echoes or inbox sync results.

## Open Questions

- What exact retention limits should the rewrite use?
- Should delete handling affect local UI only or support stronger local deletion semantics?
