# SLIP-39 golden fixtures

`slip39.golden.json` pins the compatibility invariant for the master identity
(issue #12): **same backup phrase -> same master secret bytes as the PoC
produces today**. Do not edit it by hand; do not regenerate it with this
repo's own code (that would make the tests circular).

## How it was generated

Generated on 2026-06-11 from **`slip39-ts@0.1.13`** — the exact version the
PoC resolves (`linky-poc/bun.lock`) and uses in
`linky-poc/packages/core/src/identity/utils.ts` — by a throwaway Node script
in a temp directory (`npm install slip39-ts@0.1.13`, no changes to the PoC):

- For each case (entropy hex + 15-bit share identifier + extendable flag +
  iteration exponent), the script ran the PoC's creation path
  `Slip39.fromArray(entropy, { groupThreshold: 1, groups: [[1, 1, "Linky"]], passphrase: "", title: "Linky", identifier, ... })`
  and took `slip.fromPath("r/0").mnemonics[0]` as the 20-word phrase. The
  identifier is the only randomness in share creation, and `fromArray`
  accepts it explicitly, so every fixture is fully reproducible.
- `masterSecretHex` is the output of the PoC's recovery path
  `Slip39.recoverSecret([mnemonic], "")`, asserted equal to the input entropy.
- `encryptedMasterSecretHex` is the 16-byte share value decoded from the 13
  value words (pure index arithmetic) — it pins the Feistel/PBKDF2 layer
  separately from the word encoding.
- `invalidMnemonics` were derived by mutating a valid phrase and confirmed
  invalid by `Slip39.validateMnemonic`.
- `unsupportedMnemonics` holds one member share of a 2-of-3 split
  (`groups: [[2, 3, "Linky"]]`): checksum-valid 20 words that must be
  rejected because they cannot restore an account alone.

Case selection: all-zero and all-ff entropy edges (with identifier 0 and the
max 15-bit identifier), sequential bytes, two SHA-256-derived entropies, one
non-extendable share (legacy SLIP-39 salt — the PoC accepts these on
restore), and one with iteration exponent 1.

Consumed by `../slip39.golden.test.ts`.

---

# Derived-identity golden fixtures

`derivedIdentities.golden.json` pins the compatibility invariant for the
derived identities (issue #13): **same master secret -> same Nostr keys,
same Cashu seed, same Evolu owner-lane mnemonics as the PoC produces
today**. Do not edit it by hand; do not regenerate it with this repo's own
code (that would make the tests circular).

## How it was generated

Generated on 2026-06-11 by a throwaway bun script in a temp directory that
ran the PoC's OWN identity code — `linky-poc/packages/core/src/identity/`
(`utils.ts`, `IdentityProvider.ts`, `domain.ts`, `derivationPaths.ts`,
`MasterSecretProvider.ts`, copied verbatim, PoC untouched) — against the
PoC's exact pinned dependency versions from `linky-poc/bun.lock`:
`effect@3.19.19`, `@scure/bip32@2.0.1`, `@scure/bip39@2.0.1`,
`@noble/hashes@2.0.1`, `nostr-tools@2.23.3`, `slip39-ts@0.1.13`.

Per master secret (the 7 distinct secrets from `slip39.golden.json` plus the
committed dev identities `dev/test-identities/alice.json` / `bob.json`,
whose recorded npubs the fixtures reproduce):

- **nostr**: `IdentityProvider.Live` — `HDKey.fromMasterSeed(masterSecret)`
  (the 16 secret bytes are the BIP-32 seed directly, no BIP-39 step),
  NIP-06 path `m/44'/1237'/0'/0/0`, nostr-tools `getPublicKey` (x-only
  Schnorr), `nip19.nsecEncode`/`npubEncode`.
- **cashu**: BIP-85 entropy at `m/83696968'/39'/0'/24'/0'`
  (HMAC-SHA512("bip-entropy-from-k", node.privateKey)[0..32]) -> 24-word
  BIP-39 mnemonic -> `mnemonicToSeedSync` (empty passphrase) -> 64-byte seed.
- **ownerLanes**: `deriveOwnerKeyFromMasterSecret` /
  `deriveOwnerMnemonicFromMasterSecret` for every role x index pair the PoC
  web app derives in production (`deriveOwnerSyncDataFromSeed`): meta 0,
  identity 0, and contacts/cashu/messages/transactions at indices 0 and 1.
  16 bytes of BIP-85 entropy at the lane path -> 12-word BIP-39 mnemonic.
  `domain` is the rewrite's sync-domain name; `pocRole` the PoC's (the
  `wallet` domain is the PoC's `cashu` role).

**The identity-lane fallthrough**: the PoC's `deriveOwnerPath` (utils.ts)
has no `identity` branch, so the role falls through to the messages path —
production's identity lane is `m/83696968'/39'/0'/24'/4'/0'`, identical to
messages lane 0, and the PoC's `IDENTITY_OWNER_PATH` (`.../6'/0'`) is dead
code. The fixtures pin the production behavior on purpose; restored
accounts must reconnect to the lanes app.linky.fit actually populated.

The same script generated `packages/evolu-store/test/__fixtures__/ownerLanes.golden.json`
(lane mnemonic -> Evolu AppOwner via `@evolu/common@7.4.1`).

Consumed by `../derivedIdentities.golden.test.ts`.
