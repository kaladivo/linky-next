# Contacts

Scope: Saved people, contact metadata, grouping, search, archive/block, and unknown sender handling.

Contacts are the spine of the app: a contact is at once a chat partner (via npub) and a payment recipient (via npub and/or Lightning address). Both pillars hang off the same contact list.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `contacts.list` | Contact list | Shows conversations and other contacts. | Contacts | Last message and token previews matter. |
| `contacts.search` | Search | Filters contacts. | Contacts | Combines with group filters. |
| `contacts.filter-group` | Group filters | Filters by group, no group, archived, or status currency. | Contacts | Status-currency filters depend on contacts' published status and are deferred past the first release. |
| `contacts.add` | Add contact | Adds name, npub, Lightning address, and group. | New contact, scan | Scanning an npub can create a contact directly. |
| `contacts.refresh-nostr` | Refresh from Nostr | Updates name/avatar/Lightning address from the contact's published metadata. | Add/edit/contact detail | Manual field restore exists in edit. |
| `contacts.edit` | Edit contact | Updates saved contact fields. | Contact edit | Group suggestions come from existing groups. |
| `contacts.archive` | Archive contact | Hides a contact without deleting history. | Contact edit | Archived contacts can be restored. |
| `contacts.block` | Block contact | Blocks a sender from unknown/archived contact handling. | Unknown chat, archived edit | Stops unwanted inbound chat. |
| `contacts.unknown` | Unknown contact | Represents an inbound sender not yet saved. | Inbox/chat | A local-only thread, not a normal contact row. |
| `contacts.promote-unknown` | Add unknown sender | Saves an unknown sender as a real contact. | Unknown chat | Migrates the unknown thread's messages to the new contact. |
| `contacts.delete-to-unknown` | Delete known contact | Removes a saved contact while preserving the conversation as unknown. | Contact edit | Prevents sync from recreating the old contact history. |
| `contacts.feedback` | Feedback contact | Opens a predefined contact for feedback/donations. | Menu | Stays hard-coded. Special labels in PoC. |
| `contacts.onboarding-guide` | Contacts checklist | Tracks add contact, message, top-up, backup, and pay tasks. | Contacts | Dismissible first-use guide with step highlights. |

## Flows

- `contacts.add` by scan: parse npub, detect own/existing contact, save or open existing.
- `contacts.unknown`: inbound message creates a local unknown thread; user adds or blocks it.
- `contacts.block`: confirm block, store blocked sender, publish a Nostr mute list when possible, remove the local unknown thread.

## Contracts

- Archiving never deletes chat or payment history.
- Existing-contact detection avoids duplicate npubs and Lightning addresses.
- Unknown contacts are a safety boundary for unsolicited messages.
- Unknown sender metadata may be fetched, but the localized unknown-name prefix stays display-only until saved.
- Deleting a known Nostr contact preserves history under the matching unknown thread.
- Blocking a sender prevents future sync from recreating the thread.

## Open Questions

- None.
