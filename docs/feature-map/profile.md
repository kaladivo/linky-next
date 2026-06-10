# Profile

Scope: Own public identity, profile metadata, avatar, Lightning address, status, and profile sharing.

The profile is the outward face of both pillars: the npub is how contacts message the user, and the Lightning address on the profile is how anyone pays them. Profile metadata follows standard Nostr conventions so other clients display it correctly.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `profile.view` | View profile | Shows own name, avatar, npub QR, and Lightning address. | Profile | QR is the main share/copy surface. |
| `profile.edit` | Edit profile | Edits name, avatar/photo, Lightning address, and status. | Profile edit | Publishes Nostr metadata. |
| `profile.share-nfc` | Write profile to NFC tag | Writes own profile link to a physical tag for tap-to-add. | Profile | Availability depends on device support. |
| `profile.default-linky-address` | Default Linky address | Uses the derived `${npub}@linky.fit` address for new profiles. | Onboarding, profile | Keeps the hosted receive address predictable. |
| `profile.restore-default-ln` | Restore default Lightning address | Restores the derived Linky address when no owned alias exists. | Profile edit | Hidden when a paid alias exists. |
| `profile.publish-metadata` | Publish metadata | Publishes Nostr profile metadata (kind 0). | Save profile | Name, picture, and `lud16`. |
| `profile.publish-status` | Publish status | Publishes small status/currency preferences. | Profile edit | Survives the rewrite. NIP-38 status; used by contact filters. |
| `profile.claim-lightning-address` | Claim Linky alias | Checks availability, pays the quote, saves an owned `@linky.fit` alias. | Profile claim | Deferred past the first release. Payment and hosted alias state must stay consistent. |
| `profile.reactivate-lightning-address` | Reactivate alias | Reuses an already paid hosted alias. | Profile claim | Deferred with the alias claim. No new purchase. |

## Flows

- `profile.claim-lightning-address`: check username, pay quote, finalize claim, save alias, publish `lud16`.

## Contracts

- Own npub must be copyable and shareable.
- A paid hosted alias must remain linked to hosted mint sync even if the profile `lud16` later points elsewhere.
- Do not persist a main-mint change as successful if hosted sync fails.
- Contact status filters depend on the published status format staying parseable.

## Open Questions

- None.
