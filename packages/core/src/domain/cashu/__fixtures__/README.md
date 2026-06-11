# Cashu wallet golden fixtures

`cashuWallet.golden.json` pins the compatibility invariant for the Cashu
wallet engine (issue #32): **same seed + keyset + counter -> byte-identical
deterministic secrets, blinding factors and blinded messages as the PoC
produces today** — the funds-recovery contract — plus the PoC's token
encodings, wrapped-link formats, and token-extraction behavior. Do not edit
it by hand; do not regenerate it with this repo's own code (that would make
the tests circular).

## How it was generated

Generated on 2026-06-11 by a throwaway bun script in a temp directory,
**before** the engine in `src/domain/cashu/` was written, from:

- **`@cashu/cashu-ts@2.9.0`** — the exact version the PoC resolves
  (`linky-poc/bun.lock`; also the `v2-lts` dist-tag). All NUT-13 material
  comes from the library's own exports: `deriveSecret` /
  `deriveBlindingFactor` (`@cashu/cashu-ts/crypto/client/NUT09`),
  `OutputData.createSingleDeterministicData` / `createDeterministicData`,
  `deriveKeysetId`, `getEncodedToken` (v4 + `{version: 3}`),
  `getTokenMetadata`.
- **PoC sources copied verbatim** from `linky-poc/apps/web-app/src`:
  `cashu.ts` (+ `types/json.ts`), `app/lib/tokenText.ts`
  (`extractCashuTokenFromText`; the app-types-only `extractCashuTokenMeta`
  was removed, import path adjusted), `utils/deepLinks.ts`
  (`buildCashuShareUrl` / `buildCashuDeepLink`; the `nostrNpub` import was
  stubbed — it is only used by nostr link paths). `cbor-x@1.6.0` as in the
  PoC lockfile.
- **Input seeds**: `cashuSeedHex` per identity comes from
  `../../identity/__fixtures__/derivedIdentities.golden.json` (issue #13),
  which already pins master secret -> Cashu seed against the PoC. This file
  re-states the seeds so the engine tests are self-contained; the seed
  derivation itself is pinned by #13's fixtures and re-asserted by
  `../cashuWallet.golden.test.ts`.

## What is pinned

- `derivations`: for 4 identities x 2 keyset ids (a static real-world-shaped
  id `009a1f293253e41e` and the test fake-mint keyset) x counters
  {0,1,2,3,5,31,32,33,64,100,4000}: the proof `secret` string, the NUT-13
  derived secret bytes, the blinding factor (bytes and bigint), and the
  blinded message `B_`.
- `deterministicSplits`: amount -> ordered outputs with sequential counter
  assignment (the split order IS the counter mapping).
- `restoreBlanks`: the amount-0 outputs `wallet.restore()` emits.
- `blankOutputCounts`: NUT-08 blank-output count per fee reserve (formula
  copied verbatim from PoC `cashuMelt.ts`, mirroring cashu-ts).
- `keysets.fakeMint`: the deterministic test-mint key material
  (`sha256(utf8("linky/fake-mint/sat/<amount>"))`, amounts 1..1024) and its
  `deriveKeysetId` result — the in-repo fake mint must reproduce it exactly.
- `token`: one proof set encoded as V4 (`cashuB…`) and V3 (`cashuA…`) plus
  its parsed metadata.
- `links`: the share URL (`https://linky.fit/cashu/#<encodeURIComponent>`)
  and deep link (`cashu://<token>`) the PoC builds.
- `tokenExtraction`: input -> extracted-token (or null) pairs produced by
  the PoC's `extractCashuTokenFromText` for raw tokens, `cashu:` /
  `cashu://` / `web+cashu:` schemes, linky.fit share links, query-parameter
  URLs, free text, whitespace-mangled tokens, and negatives.

## What is NOT pinned (trusted to cashu-ts 2.9.0)

End-to-end mint/melt/swap wire exchanges need a live mint, so they cannot be
fixture-captured from the PoC. The BDHKE math (blinding/unblinding,
signature verification) and the HTTP wire format are trusted to cashu-ts —
the same exact version the PoC runs, byte-compatible by construction. The
engine's counter PLUMBING on top of it is verified two ways:

- the golden end-to-end test runs `receiveToken` against the in-repo fake
  mint (which signs with cashu-ts's own mint-side crypto) and asserts the
  resulting proof secrets equal the pinned `derivations`;
- behavior tests assert counter advancement/collision semantics per flow.

## Known deliberate divergence from the PoC

cashu-ts 2.9.0 treats a literal counter of **0** as "no counter" inside
`createSwapPayload` (falsy check), so the PoC's first receive/send on every
fresh keyset silently emitted RANDOM outputs that NUT-09 restore can never
recover. The engine never consumes slot 0 (`MIN_COUNTER = 1` in
`../internal/deterministic.ts`); restore still scans from 0. The
`derivations` fixtures at counter 0 remain pinned for restore compatibility
with PoC wallets whose mint/melt flows (where counter 0 worked) signed
slot 0.

Consumed by `../cashuWallet.golden.test.ts`.
