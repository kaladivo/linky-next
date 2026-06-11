# Dev test identities

Two **throwaway development identities** for the standard two-instance
verification scenario (chat + payments between two app instances on testnet).

> **WARNING — never put real funds on these identities.**
> The mnemonics below are committed to a public-ish repository, so anyone can
> derive every key. They exist only for test mints (`testnut.cashu.space`) and
> public dev relays. Production builds must never see them.

## Format

Each identity is a single **SLIP-39 share** (20 words): a 1-of-1 group share
generated from 16 bytes of entropy with an empty passphrase and title
`Linky` — the exact format the PoC produces
(`linky-poc/packages/core/src/identity/utils.ts → createSlip39Share`) and
that `@linky/core` reproduces (issue #12). Recovering the share yields the
16-byte master secret; all keys (Nostr, Cashu seed, Evolu owner lanes) derive
from it via the documented BIP-32/BIP-85 paths.

The PoC has no committed test mnemonics, so these two were freshly generated
with the same library (`slip39-ts`) and verified to round-trip
(share → master secret → share-compatible recovery) and to derive valid Nostr
keys via the PoC's `m/44'/1237'/0'/0/0` path.

## Identities

|      | alice                                                             | bob                                                               |
| ---- | ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| File | [`alice.json`](./alice.json)                                      | [`bob.json`](./bob.json)                                          |
| npub | `npub1rteqaztwefwwlwyupkrx6wsmhkxa63qnkc2k38yuv9gnqsukdd7qw8qw9d` | `npub1swl0lmqxtuz75j6chdq9p3lntq5ruf792458fhdty7wlm4kw7ecq47mgja` |

Each JSON file contains the 20-word SLIP-39 mnemonic plus derived reference
values (master-secret entropy hex, Nostr pubkey hex, npub) so tests and
scripts can assert against them without re-deriving.

## Usage

`scripts/dev-two-sims.sh` boots two simulators with the dev app and restores
**alice** on the first and **bob** on the second by driving the onboarding
restore flow (#18) with `agent-device` UI automation (stable testIDs:
`language-continue` → `onboarding-restore-link` → `restore-word-input` +
typed mnemonic → `restore-confirm`). Re-run just the restore step against
already-running, logged-out apps with `scripts/dev-two-sims.sh restore-only`.

Both identities also restore through the regular onboarding restore screen
(type or paste the 20 words). A dev-gated `/dev/restore?phrase=` route
exists too (`apps/mobile/app/dev/restore.tsx`), but external deep links do
not reach it in development builds — expo-dev-launcher swallows
`linky-dev://` URLs (see the route docstring).
