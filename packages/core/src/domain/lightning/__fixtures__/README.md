# Lightning / LNURL golden fixtures

`lightning.golden.json` pins the PoC's BOLT11 preview parsing and LNURL
target resolution semantics for issue #34. Do not edit it by hand; do not
regenerate it with this repo's own code (that would make the tests circular).

## How it was generated

Generated on 2026-06-11, **before** `src/domain/lightning/` was written, by
running `generate.poc.ts.txt` (copied verbatim here for provenance) with bun
from inside `linky-poc/apps/web-app`, importing the PoC's own modules:

- `apps/web-app/src/utils/lightningInvoice.ts` — `getLightningInvoicePreview`,
  `parseBolt11AmountMsat`, `getLightningInvoiceDescriptionHashHex` (hand-rolled
  BOLT11 HRP/tagged-field parsing over `@scure/base` bech32, the PoC's only
  bolt11 "library").
- `apps/web-app/src/lnurlPay.ts` — `isLightningAddress`, `isLnurlPayTarget`,
  `isLnurlWithdrawTarget`, `resolveLnurlPayRequestUrl`,
  `getLnurlPayDisplayText`, `inferLightningAddressFromLnurlTarget`.
- `@scure/base@2.x` as resolved by the PoC lockfile (bech32 codec).

Invoice inputs are the BOLT #11 specification example invoices
(lightning/bolts `11-payment-encoding.md`, signed with the spec's well-known
test key) plus synthetic invoices assembled with bech32 in the generator.

## Known, intentional divergences (asserted in `lightning.golden.test.ts`)

The new parser fixes two PoC bugs; the golden file keeps the PoC outputs
verbatim and the golden test carries an explicit divergence table:

1. **`lnbcrt` amounts** — the PoC prefix regex `/(lnbc|lntb|lnbcrt)/` lets the
   `lnbc` alternative win for regtest invoices, so `lnbcrt500n…` parses as
   amountless (`amountMsat: null`). The new parser orders `lnbcrt` first and
   returns 50 000 msat.
2. **`lnurlp://user@domain`** — the PoC checks "is lightning address" before
   stripping the `lnurlp://` scheme, producing the nonsense URL
   `https://domain/.well-known/lnurlp/lnurlp%3A%2F%2Fuser`. The new parser
   strips the scheme first (the behavior `normalizeLnurlSchemeUrl` in the PoC
   was clearly written to have) and resolves `user@domain`'s well-known URL.

## `lnurlPayCallback.golden.json` (issue #39)

Pins the PoC's LNURL-pay WIRE behavior: the metadata request URL, min/max
sat preview rounding, and the invoice-callback request URLs (amount param,
LUD-12 comment handling incl. the silent no-comment retry). Generated on
2026-06-12 by running `generate-callback.poc.ts.txt` (verbatim provenance
copy) with bun from inside `linky-poc/apps/web-app`, importing the PoC's own
`src/lnurlPay.ts` with a stubbed global fetch that records every request.

Intentional divergences (asserted in `lnurlPayCallback.golden.test.ts`):

1. **Inverted LUD-12 condition** — the PoC only ever sent a comment to
   providers that did NOT advertise `commentAllowed` (the advertised-comment
   URL was built, then ignored). Core sends the truncated comment exactly
   when support is advertised.
2. **Query encoding** — PoC `URLSearchParams` spells a space `+`, core's
   `appendQueryParams` spells it `%20`; same x-www-form-urlencoded value,
   normalized in the golden comparison.
