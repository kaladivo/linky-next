# Chat

Scope: One-to-one private Nostr messaging: send, receive, reply, edit, react, delete, and retention.

This is a deliberately simple messenger. There are no group conversations, channels, broadcasts, or public posts — only direct conversations between two people. Message mechanics follow the patterns of existing Nostr DM clients; only Linky-specific behavior is listed below.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `chat.send-message` | Send message | Sends a private text message to a contact. | Chat | Shows an optimistic pending state. |
| `chat.receive-message` | Receive message | Syncs private messages from the Nostr network. | Chat, inbox sync | Unknown senders create unknown contacts. |
| `chat.reply` | Reply | Attaches reply/thread context to a message. | Message actions | |
| `chat.edit-message` | Edit | Edits an own text message. | Message actions | Original content is preserved locally. |
| `chat.react` | React | Sends an emoji reaction; shows the latest reaction per person. | Message actions | One visible reaction per user. |
| `chat.delete` | Delete handling | Applies delete events to messages and reactions. | Sync | Duplicate delete events must not double-apply. |
| `chat.pending-ack` | Pending ack | Reconciles optimistic outgoing messages with their delivered copies. | Sync | Prevents sent messages from appearing twice or staying pending. |
| `chat.retention` | Retention | Keeps full message history without hard caps. | Background | PoC capped 500/contact, 3000 global, 5000 reactions; the rewrite drops these caps and relies on sync storage rotation (see Data & Sync) to bound storage. |

## Flows

- `chat.receive-message`: fetch wrapped private events, unwrap, validate sender, dedupe, store message/reaction/delete.
- `chat.pending-ack`: show local pending message, mark sent once the delivered copy is observed.

## Contracts

- Conversations are strictly one-to-one; nothing in the data model or UI should assume group chats.
- Chat uses NIP-17/NIP-59 gift-wrapped private messages, so conversations interoperate with other Nostr messengers.
- Malformed or spoofed events (nested encrypted payloads, mismatched sender identity) are ignored.
- After switching to a custom key, events older than the switch can be filtered out.
- Message history must not duplicate the same message arriving via different sync paths.
- Users can delete a chat with the common messenger delete UX; the exact deletion semantics behind it (local-only vs stronger) are an implementation decision. Decided (#29): account-local "delete for me" — all message/reaction rows of the conversation are soft-deleted (tombstones sync to the user's own devices via the messages lane; rumor-id dedup keeps re-synced wraps from resurrecting them), no Nostr deletion event is sent (the peer keeps their copy), and a NEW inbound message restarts the conversation (recreating the unknown thread when the sender is not a contact).

## Open Questions

- None.
