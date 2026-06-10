# Contacts

Scope: Saved people, contact metadata, grouping, search, archive/block, and unknown sender handling.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `contacts.list` | Contact list | Shows conversations and other contacts. | Contacts | Last message and token previews matter. |
| `contacts.search` | Search | Filters contacts. | Contacts | Search combines with group filters. |
| `contacts.filter-group` | Group filters | Filters by group, no group, archived, or status currency. | Contacts | Status currency filters depend on profile status fetch. |
| `contacts.add` | Add contact | Adds name, npub, Lightning address, and group. | New contact, scan | npub scan can create contact directly. |
| `contacts.refresh-nostr` | Refresh from Nostr | Updates name/avatar/Lightning address from metadata. | Add/edit/contact detail | Manual field restore exists in edit. |
| `contacts.edit` | Edit contact | Updates saved contact fields. | Contact edit | Group suggestions come from existing groups. |
| `contacts.archive` | Archive contact | Hides normal contact without deleting history. | Contact edit | Archived contacts can be restored. |
| `contacts.block` | Block contact | Blocks a pubkey from unknown/archived contact handling. | Unknown chat, archived edit | Used to stop unwanted inbound chat. |
| `contacts.unknown` | Unknown contact | Represents inbound sender not yet saved. | Inbox/chat | Local-only `unknown:<pubkey>` thread, not a normal contact row. |
| `contacts.promote-unknown` | Add unknown sender | Saves an unknown sender as a real contact. | Unknown chat | Migrates existing unknown-thread messages to the new contact. |
| `contacts.delete-to-unknown` | Delete known contact | Removes saved contact while preserving conversation as unknown. | Contact edit | Prevents stale sync from recreating old contact history. |
| `contacts.feedback` | Feedback contact | Opens a predefined contact for feedback/donations. | Menu | Special labels in PoC. |
| `contacts.onboarding-guide` | Contacts checklist | Tracks add contact, message, top-up, backup, and pay tasks. | Contacts | Dismissible first-use guide with step highlights. |

## Flows

- `contacts.add` by scan: parse npub, detect own/existing contact, save or open existing.
- `contacts.unknown`: inbound message creates local unknown thread, user adds or blocks it.
- `contacts.block`: confirm block, store blocked pubkey, publish mute list when possible, remove local unknown thread.

## Contracts

- Archiving must not delete chat/payment history.
- Existing contact detection should avoid duplicate npubs and Lightning addresses.
- Unknown contacts are a safety boundary for unsolicited messages.
- Unknown sender metadata may be fetched, but the localized unknown-name prefix stays UI-only until saved.
- Deleting a known Nostr contact should preserve history under the matching unknown thread.
- Blocking a pubkey should prevent future inbox sync from recreating the thread.

## Open Questions

- Should status-currency contact filters ship or move later?
- Should feedback contact remain hard-coded?
