# Linky Feature Map

This directory defines what Linky does. It is the product and behavior inventory for the rewrite.

The feature map is not the rewrite spec and not the roadmap. Feature files answer three things: what behavior exists, what must not be forgotten, and what questions remain. How each behavior is implemented and when it ships is decided elsewhere.

## Product Summary

Linky is two well-known app types fused into one:

- **A simple Nostr messenger.** One-to-one private conversations only — no group chats, no channels, no public feed. Contacts, profiles, and messaging follow patterns established by existing Nostr messaging clients.
- **A Cashu ecash wallet.** Hold ecash, send and receive tokens, pay and get paid over Lightning, manage mints. Wallet behavior follows patterns established by existing Cashu wallets.

What makes Linky distinct is the fusion, not the parts: a contact is both a chat partner and a payment recipient, money moves inside conversations, and one backup phrase recovers everything — identity, messages, funds, and settings. Everything else in the app is a supporting layer for these two pillars.

The PoC is a behavior reference only. Its code boundaries, storage choices, and UI structure are not rewrite requirements.

## Feature Areas

### Foundation

One identity behind both pillars: the backup phrase that recovers messages, funds, and data alike.

| Area | Scope |
|---|---|
| [Onboarding](onboarding.md) | First run: create or restore an account, profile setup, backup prompt. |
| [Account & Identity](account-identity.md) | The master backup identity, derived identities, secrets, backup, restore. |

### Messenger Pillar

A simple one-to-one Nostr messenger, interoperable with other Nostr clients.

| Area | Scope |
|---|---|
| [Contacts](contacts.md) | Saved people, groups, search, archive/block, unknown senders. The spine of the app. |
| [Chat](chat.md) | One-to-one private messaging: send, receive, reply, edit, react, delete. |
| [Profile](profile.md) | Own public identity: name, avatar, npub, Lightning address, status. |
| [Nostr Network](nostr-network.md) | Relays, publishing, inbox sync, profile metadata fetch. |

### Wallet Pillar

A Cashu ecash wallet with Lightning in and out.

| Area | Scope |
|---|---|
| [Wallet](wallet.md) | Wallet home: balance, receive/send entry points, amount display. |
| [Cashu](cashu.md) | Ecash token lifecycle: receive, top-up, send, validate, restore. |
| [Lightning & LNURL](lightning-lnurl.md) | Paying invoices, Lightning addresses, LNURL pay/withdraw. |
| [Mints](mints.md) | Main mint choice, multi-mint balances, consolidation, hosted address sync. |
| [Transactions](transactions.md) | Local payment history and payment telemetry. |

### Where the Pillars Meet

The behavior that makes Linky more than a messenger next to a wallet.

| Area | Scope |
|---|---|
| [Chat Payments](chat-payments.md) | Sending money and payment requests inside conversations. |

### Supporting Layers

Not product pillars; they exist to serve the messenger and the wallet.

| Area | Scope |
|---|---|
| [Scanner & Input](scanner-input.md) | Camera, paste, gallery, links, and NFC input, routed to the right flow. |
| [Notifications](notifications.md) | Alerting users about messages and payments, including while the app is closed. |
| [Data & Sync](data-sync.md) | Local-first data, cross-device sync, sync servers, data maintenance. |
| [App Shell](app-shell.md) | Navigation, shared feedback, localization, startup behavior. |
| [Settings & Advanced](settings-advanced.md) | Preferences, support controls, diagnostics, destructive actions. |
| [Public Site](public-site.md) | linky.fit website, public Cashu redeem page, hosted address endpoints. |

## Feature File Rules

- Keep files concise.
- Do not explain obvious UI mechanics.
- Include a note only when forgetting it would change behavior, lose compatibility, create user confusion, or risk funds, keys, sync, or privacy.
- Describe behavior, not implementation. Frameworks, storage engines, and platform/client distinctions belong in the rewrite spec.
- Protocol names (Nostr, Cashu, Lightning, NIPs, NUTs) are allowed where interoperability is the behavior.
- Where behavior matches established Nostr messenger or Cashu wallet conventions, say so and document only Linky-specific deviations. Do not re-specify what those app categories already define.
- Use `Open Questions` for decisions that belong in the rewrite spec or roadmap.

## Feature IDs

Use stable IDs in this form:

```text
<group>.<verb>
<group>.<verb>-<object>
```

Examples:

```text
identity.restore
contacts.archive
cashu.accept-token
chat.send-message
lightning.pay-invoice
notifications.enable
```

IDs should not encode priority, platform, or implementation.

## Shared Contracts

- One master backup identity is the root of the whole account.
- Nostr identity, Cashu wallet seed, and sync identities all derive deterministically from the master identity, so a restored account reconnects to its messages, funds, and synced data.
- A custom Nostr key can override the derived identity when supported.
- Existing Linky backups must remain restorable.
- Production can handle real funds. Development and staging must default away from real funds.
- Private keys, seeds, proofs, and payment-sensitive values never leave the user's device and must never be logged.
- Local data renders before any network refresh.

## Shared Data Terms

- `master identity`: the root backup identity behind the backup phrase.
- `npub` / `nsec`: Nostr public/private identity.
- `main mint`: preferred Cashu mint for receive and consolidation.
- `foreign mint`: a mint holding spendable balance that is not the main mint.
- `unknown contact`: inbound Nostr sender not yet saved as a normal contact.
