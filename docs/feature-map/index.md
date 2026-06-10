# Linky Feature Map

This directory defines what Linky does. It is the product and behavior inventory for the rewrite.

The feature map is not the rewrite spec and not the roadmap. Feature files should answer: what behavior exists, what must not be forgotten, and what questions remain. The rewrite spec will decide how the new app implements those behaviors. The roadmap will decide when each feature ships.

## Product Summary

Linky is a mobile-first app for contacts, private Nostr messaging, Cashu wallet flows, and Lightning payments. It is local-first through Evolu sync, with identity rooted in a user backup key.

The PoC is a behavior reference only. Its code boundaries, storage choices, and UI structure are not rewrite requirements.

## Feature File Rules

- Keep files concise.
- Do not explain obvious UI mechanics.
- Include a note only when forgetting it would change behavior, lose compatibility, create user confusion, or risk funds, keys, sync, or privacy.
- Avoid implementation detail unless behavior depends on it.
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
native.write-nfc
```

IDs should not encode priority, platform, or implementation.

## Shared Contracts

- SLIP-39 master identity is the root identity.
- Nostr keys are derived from the master identity by default.
- Custom Nostr keys can override the derived identity when supported.
- Evolu owner lanes are deterministic from the master identity.
- Cashu wallet seed and deterministic wallet counters must remain reliable.
- Production can handle real mainnet funds.
- Development and staging must default away from mainnet funds.
- Private keys, seeds, proofs, and payment-sensitive values must not be logged.
- Local-first behavior should prefer local state before network refresh.

## Shared Data Terms

- `master identity`: the root backup identity.
- `npub` / `nsec`: Nostr public/private identity.
- `owner lane`: deterministic Evolu ownership scope for a data class.
- `main mint`: preferred Cashu mint for receive and consolidation.
- `foreign mint`: a mint holding spendable balance that is not the main mint.
- `unknown contact`: inbound Nostr sender not yet saved as a normal contact.
