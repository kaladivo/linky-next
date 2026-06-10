# Cashu

Scope: Token lifecycle, wallet seed behavior, receive/top-up, send/emit, validation, restore, and token detail.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `cashu.parse-token` | Parse token | Extracts token, mint, amount, unit where possible. | Scan, paste, deeplink, chat | Handles raw token and wrapped links. |
| `cashu.accept-token` | Accept token | Stores and marks received token accepted. | Scan, paste, chat, site deeplink | Dedupe matters. |
| `cashu.validate-token` | Validate token | Checks proof state and deletes/marks invalid when needed. | Token detail, token list | Uses mint check APIs. |
| `cashu.restore-token` | Restore tokens | Attempts to recover missing wallet value. | Token list | Depends on deterministic wallet seed/counters. |
| `cashu.topup-quote` | Top-up quote | Creates mint quote and Lightning invoice. | Receive amount | Quote can be cached until claimed/expired. |
| `cashu.claim-topup` | Claim top-up | Claims paid mint quote into proofs. | Top-up invoice | Treats `ISSUED` as claim-relevant. |
| `cashu.no-amount-receive` | No-amount receive | Shows reusable QR for own Lightning address. | Receive | LNURL-pay style receive. |
| `cashu.emit-token` | Emit token | Creates outgoing token for an amount. | Token list, send scan | Creates issued token row. |
| `cashu.token-detail` | Token detail | Shows amount, mint, QR, copy/share/check/delete. | Token list | Raw token string is hidden behind QR/copy. |
| `cashu.share-token` | Share token | Shares public Linky Cashu URL for a token. | Token detail | Uses `linky.fit/cashu/#...` so token stays out of request path/query. |
| `cashu.reserve-token` | Reserve token | Marks own accepted token unavailable. | Token detail | Manual support/repair feature. |
| `cashu.externalize-token` | Externalize token | Marks token written outside wallet. | NFC/share | Excluded from available balance. |
| `cashu.return-token` | Return token | Re-accepts unavailable token into wallet. | Token detail | Used for externalized/unavailable states. |
| `cashu.cleanup-spent` | Clean spent tokens | Bulk-checks tokens and deletes/marks spent or claimed rows. | Token list | Keeps old rows from confusing balances/history. |

## Flows

- `cashu.topup-quote`: amount, create mint quote, show invoice QR, cache quote, claim paid quote.
- `cashu.emit-token`: select spendable proofs, create token, store issued row, detect when claimed.
- `cashu.accept-token`: parse, dedupe, accept from mint, store accepted token, log receive.

## Contracts

- Cashu wallet seed and counters must be deterministic.
- Token state affects balance and spendability.
- Spendable balance excludes issued, pending, reserved, externalized, spent, deleted, and error tokens.
- Top-up quote ids and proofs should not pass through Linky servers.
- Mint compatibility fallback exists for mints that fail library keyset verification.
- Token share links should prefer public-site hash fragments to avoid leaking tokens to servers.

## Open Questions

- Which manual repair states/actions should remain user-visible?
- What exact token states should the new data model support?
