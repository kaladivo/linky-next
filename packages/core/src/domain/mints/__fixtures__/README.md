# Mints golden fixtures (issues #41, #42)

`mints.golden.json` pins the PoC's mint-management semantics: mint URL
normalization (`utils/mint.ts normalizeMintUrl` / `getMintOriginAndHost`),
selection display names, NUT-06 info parsing (`mintInfoHelpers.ts
parseMintInfoPayload` / `getMintInfoIconUrl`, incl. the 1000-char storage
cap), hosted npub.cash server resolution (`utils/npubCashServer.ts`), and
the NIP-98 hosted mint-sync request (`useNpubCashMintSelection.ts
makeNip98AuthHeader` + `updateNpubCashMint`: PUT `/api/v1/info/mint`, body
`{"mintUrl":…}`, `Nostr <base64 event>` header).

Do not edit by hand; do not regenerate with this repo's own code (that
would make the tests circular).

## How it was generated

Generated on 2026-06-12, **before** `src/domain/mints/` was written, by
running `generate.poc.ts.txt` (copied verbatim here for provenance) with
bun from inside `linky-poc/apps/web-app`, importing the PoC's own modules
and `nostr-tools@2.23.3` as resolved by the PoC lockfile. For the NIP-98
cases the global `Date` is frozen per case (nostr-tools reads
`new Date().getTime()` for `created_at`); the Schnorr signature is
randomized (BIP-340 aux entropy), so fixtures store the event JSON with the
`sig` value masked as `"SIG"` — everything else, including JSON key order,
is byte-exact.

## Known, intentional divergences (asserted in `mints.golden.test.ts`)

1. **Non-http(s) mint URLs** — the PoC leaks WHATWG internals:
   `normalizeMintUrl("foo://bar/baz")` → `"null/baz"` (`URL.origin` of a
   non-special scheme is the literal string `"null"`). The rewrite returns
   the trimmed/trailing-slash-stripped input unchanged. Identical for all
   http(s) inputs.
2. **`isTestMintUrl`** — the rewrite's allowlist
   (`TEST_MINT_HOSTS` in EnvironmentConfig.ts, part of the structural
   mainnet guard) is a deliberate superset of the PoC's
   (`TEST_MINTS = [testnut]`): it also treats
   `nofees.testnut.cashu.space` and localhost as test mints.

## consolidation.golden.json (issue #42)

Pins the PoC's consolidation policy: the full-balance fee-retry ladder
(`paymentAmountFallback.ts`: `buildPaymentAmountAttempts` over fee steps
[0,1,2,3,5,8,13,21], `getPaymentAmountShortage`,
`isRetryablePaymentAmountFailure`, `buildPaymentFailureAmountAttempts`),
the autoswap threshold (`CASHU_AUTOSWAP_MIN_SOURCE_SUM = 128`), and the
select-main autoswap plan (`useNpubCashMintSelection.ts
getMintSelectionAutoswapPlan`). Generated on 2026-06-12, **before**
`consolidation.ts` was written, by running
`consolidation.generate.poc.ts.txt` (copied verbatim here) with bun from
inside `linky-poc/apps/web-app`, importing the PoC's own modules. Asserted
by `consolidation.golden.test.ts`. The plan fixture cases only use mints
both repos classify identically (the `isTestMintUrl` superset divergence
above applies to `getMintSelectionAutoswapPlan` too).

PoC behaviors that are inline code (not importable) — the largest-foreign
source selection, the probe-sizing queue rewrite, the 8-attempt cap, the
800ms retry pause and the test-mint autoswap force-disable — are
replicated in `consolidation.ts` and covered by `consolidation.test.ts`
unit tables instead (documented divergence: source-selection ties resolve
lexicographically; the PoC's tie-break depended on row insertion order).
