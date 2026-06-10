# Account & Identity

Scope: The master backup identity, derived app identities, secret handling, backup, and restore.

Foundation for both pillars: one backup phrase deterministically yields the messenger identity (Nostr keys), the wallet (Cashu seed), and the sync identities. Restoring it recovers messages, funds, and data together.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `identity.create` | Create account | Creates the master identity and all derived app identities. | Onboarding | Root identity is one 20-word backup phrase (SLIP-39). |
| `identity.restore` | Restore account | Restores the full account from backup words. | Onboarding | Must handle invalid, partial, pasted, and separator-normalized input. |
| `identity.derive-nostr` | Derived Nostr identity | Produces the default `nsec` / `npub` from the master identity. | Onboarding, restore, advanced | Default identity path. |
| `identity.use-custom-nostr-key` | Custom Nostr key | Uses a pasted `nsec` instead of the derived key. | Advanced | Ships in the first release. Identity switch affects which chat history syncs. |
| `identity.derive-cashu-seed` | Cashu seed | Derives the deterministic wallet seed. | Onboarding, restore | Fund recovery depends on this staying stable. |
| `identity.derive-sync-identities` | Sync identities | Derives deterministic sync identities so synced data reconnects after restore. | Onboarding, restore | Contacts, wallet, messages, transactions, identity, and meta data sync as separate domains. |
| `identity.persist-secrets` | Store secrets | Keeps secrets on the device for app use. | Onboarding, restore, login | Stored as securely as the device allows. |
| `identity.backup` | Backup identity | Lets user save/copy/export recovery material. | Onboarding, advanced | Funds and sync recovery depend on it. |
| `identity.logout` | Logout | Clears local session secrets. | Advanced | Must not imply remote deletion. |

## Flows

- `identity.create`: create master identity, derive Nostr/Cashu/sync identities, create profile, prompt backup.
- `identity.restore`: validate backup words, derive identities, reconnect local and synced data.
- `identity.use-custom-nostr-key`: save override, record switch time, ignore older incoming events from the prior identity where needed.

## Contracts

- The 20-word backup phrase format must stay compatible with existing Linky backups.
- All derived identities (Nostr, Cashu seed, sync) are deterministic from the master identity.
- The derived Nostr identity is the default; a custom key is an explicit override.
- Secrets never leave the device and must never be logged.
- Logout clears local secrets only; synced data and funds remain recoverable from backup.
- Backup confirmation matches PoC behavior: strongly prompted, never required before normal app access.

## Open Questions

- None.
