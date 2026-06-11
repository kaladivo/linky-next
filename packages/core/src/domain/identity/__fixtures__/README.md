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
