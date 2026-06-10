# Profile

Scope: Own public identity, profile metadata, avatar, Lightning address, and status.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `profile.view` | View profile | Shows own name, avatar, npub QR, and Lightning address. | Profile | QR is share/copy surface. |
| `profile.edit` | Edit profile | Edits name, avatar/photo, Lightning address, and status. | Profile edit | Publishes Nostr metadata. |
| `profile.default-linky-address` | Default Linky address | Uses derived `${npub}@linky.fit` address for new profiles. | Onboarding/profile | Keeps hosted receive address predictable. |
| `profile.restore-default-ln` | Restore default Lightning address | Restores derived Linky address when no owned alias exists. | Profile edit | Hidden when paid alias exists. |
| `profile.publish-metadata` | Publish metadata | Publishes Nostr kind 0 metadata. | Save profile | Name, picture, and `lud16`. |
| `profile.publish-status` | Publish status | Publishes small status/currency preferences. | Profile edit | NIP-38 `kind:30315`, `d=general`; used by contact filters. |
| `profile.claim-lightning-address` | Claim Linky alias | Checks availability, pays quote, saves owned `@linky.fit` alias. | Profile claim | Payment and hosted alias state must stay consistent. |
| `profile.reactivate-lightning-address` | Reactivate alias | Reuses an already paid hosted alias. | Profile claim | No new purchase. |

## Flows

- `profile.claim-lightning-address`: check username, pay quote, finalize claim, save alias, publish `lud16`.

## Contracts

- Own npub must be copyable/shareable.
- Paid hosted alias must remain linked to hosted mint sync even if profile `lud16` later points elsewhere.
- Do not persist a main-mint change as successful if hosted sync fails.
- Contact status filters depend on the published status format staying parseable.

## Open Questions

- Is paid `@linky.fit` alias claim part of first mobile release?
- Should profile status/currency publishing survive the rewrite?
