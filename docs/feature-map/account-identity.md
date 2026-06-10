# Account & Identity

Scope: Account creation, restore, secret handling, and derived app identities.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `identity.create` | Create account | Creates the master identity and derived app identities. | Onboarding | Root identity is one 20-word SLIP-39 share. |
| `identity.restore` | Restore account | Restores identities from backup words. | Onboarding | Must handle invalid, partial, pasted, and separator-normalized input. |
| `identity.derive-nostr` | Derived Nostr identity | Produces default `nsec` / `npub`. | Onboarding, restore, advanced | Default identity path. |
| `identity.use-custom-nostr-key` | Custom Nostr key | Uses a pasted `nsec` instead of the derived key. | Advanced | Identity switch affects chat sync boundaries. |
| `identity.derive-cashu-seed` | Cashu seed | Derives deterministic wallet seed. | Onboarding, restore | Counters/proofs depend on this staying stable. |
| `identity.derive-evolu-owners` | Evolu owners | Derives deterministic owner lanes. | Onboarding, restore, storage | Separate lanes exist for identity, contacts, cashu, messages, transactions, and meta. |
| `identity.persist-secrets` | Store secrets | Persists secrets for app use. | Onboarding, restore, login | Web uses browser storage; native must use secure platform storage. |
| `identity.backup` | Backup identity | Lets user save/copy/export recovery material. | Onboarding, advanced | Funds and sync recovery depend on it. |
| `identity.logout` | Logout | Clears local session secrets. | Advanced | Must not imply remote deletion. |

## Flows

- `identity.create`: create master identity, derive Nostr/Cashu/Evolu identities, create profile, prompt backup.
- `identity.restore`: validate backup words, derive identities, reconnect local/synced data.
- `identity.use-custom-nostr-key`: save override, record switch time, ignore older incoming events from prior identity where needed.

## Contracts

- SLIP-39 remains the root identity.
- Existing 20-word backup shares must remain restorable.
- Derived Nostr identity is the default.
- Cashu seed derivation is deterministic.
- Evolu owner lane derivation is deterministic.
- Secret storage is a platform capability, not product logic.
- Private keys/seeds may be mirrored only where the platform requires it and must never be logged.

## Open Questions

- Does custom Nostr key support ship in the first mobile release?
- Is backup confirmation required before normal app access?
