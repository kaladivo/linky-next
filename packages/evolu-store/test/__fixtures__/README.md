# Owner-lane golden fixtures

`ownerLanes.golden.json` pins the compatibility invariant for Evolu owner
derivation (issue #13): **same master secret -> same owner-lane mnemonic ->
same Evolu `AppOwner` (id, encryption key, write key) as the PoC
(app.linky.fit) produces today**, for all six sync domains (`meta`,
`identity`, `contacts`, `wallet`, `messages`, `transactions`) and rotation
indices 0/1 of the rotating ones. Do not edit by hand; do not regenerate
with this repo's own code (that would make the tests circular).

## How it was generated

Generated on 2026-06-11 by the same throwaway bun script as
`packages/core/src/domain/identity/__fixtures__/derivedIdentities.golden.json`
(see the README there for the full mechanism and dependency pins, including
the identity-lane fallthrough quirk: production's `identity` lane equals
`messages` lane 0):

- lane mnemonics: the PoC's own `deriveOwnerMnemonicFromMasterSecret`
  (`linky-poc/packages/core/src/identity/utils.ts`, copied verbatim) with
  the PoC's pinned deps,
- owners: `createAppOwner(mnemonicToOwnerSecret(Mnemonic.fromUnknown(m).value))`
  from **`@evolu/common@7.4.1`** — the exact version this package pins and
  the PoC web app ships (`toAppOwnerFromMnemonic` in
  `useEvoluContactsOwnerRotation.ts`).

`wallet` is the PoC's `cashu` role (same derivation path); `masterSecretHex`
values are the #12 fixture secrets plus the committed dev identities
`dev/test-identities/alice.json` / `bob.json`.

Consumed by `../ownerLanes.golden.test.ts`, which verifies the full chain:
`@linky/core` `deriveOwnerLane` -> `appOwnerFromMnemonic` (this package) ->
pinned owner ids. Owner derivation lives in this package because it needs
`@evolu/common`, which core must never import — the 12-word lane mnemonic is
the contract between the two packages.
