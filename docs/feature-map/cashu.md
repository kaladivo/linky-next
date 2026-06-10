# Cashu

Scope: Ecash token lifecycle: receive, top-up, send, validate, restore, token detail, and token sharing.

This follows the standard Cashu wallet pattern — mint to receive over Lightning, melt to pay, send/accept tokens, deterministic restore. Tokens stay interoperable with other Cashu wallets. Linky-specific additions are mostly around token state tracking (issued/externalized/reserved) and sharing.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `cashu.parse-token` | Parse token | Extracts token, mint, amount, unit where possible. | Scan, paste, link, chat | Handles raw tokens and wrapped links. |
| `cashu.accept-token` | Accept token | Stores and marks a received token accepted. | Scan, paste, chat, site link | Dedupe matters. |
| `cashu.validate-token` | Validate token | Checks proof state with the mint and deletes/marks invalid tokens. | Token detail, token list | |
| `cashu.restore-tokens` | Restore tokens | Attempts to recover missing wallet value from the mint. | Token list | Depends on the deterministic wallet seed and counters. |
| `cashu.topup-quote` | Top-up quote | Creates a mint quote and Lightning invoice for an amount. | Receive amount | Quote can be cached until claimed or expired. |
| `cashu.claim-topup` | Claim top-up | Claims a paid mint quote into wallet value. | Top-up invoice | Already-issued quotes still count as claim-relevant. |
| `cashu.no-amount-receive` | No-amount receive | Shows a reusable QR for the user's own Lightning address. | Receive | LNURL-pay style receive. |
| `cashu.emit-token` | Emit token | Creates an outgoing token for an amount. | Token list, send scan | Creates an issued token entry. |
| `cashu.token-detail` | Token detail | Shows amount, mint, QR, copy/share/check/delete. | Token list | Raw token string stays hidden behind QR/copy. |
| `cashu.share-token` | Share token | Shares a public Linky link for a token. | Token detail | Link format keeps the token out of server logs. |
| `cashu.write-nfc` | Write token to NFC tag | Writes a token to a physical tag and externalizes it. | Token detail | Availability depends on device support. |
| `cashu.reserve-token` | Reserve token | Marks an own accepted token unavailable. | Token detail | Manual support/repair feature. |
| `cashu.externalize-token` | Externalize token | Marks a token as living outside the wallet. | NFC write, share | Excluded from available balance. |
| `cashu.return-token` | Return token | Re-accepts an unavailable token into the wallet. | Token detail | Used for externalized/unavailable states. |
| `cashu.cleanup-spent` | Clean spent tokens | Bulk-checks tokens and deletes/marks spent or claimed entries. | Token list | Keeps old entries from confusing balances and history. |

## Flows

- `cashu.topup-quote`: enter amount, create mint quote, show invoice QR, cache quote, claim once paid.
- `cashu.emit-token`: select spendable value, create token, store issued entry, detect when claimed.
- `cashu.accept-token`: parse, dedupe, accept from mint, store accepted token, log the receive.

## Contracts

- Cashu wallet seed and counters are deterministic so funds are recoverable.
- Token state determines balance and spendability: issued, pending, reserved, externalized, spent, deleted, and error tokens are not spendable.
- Top-up quotes and proofs never pass through Linky servers.
- Some mints need a compatibility fallback to remain usable; payments must not silently fail on them.
- Shared token links must not expose the token to any server.
- Token states and user-visible manual repair actions follow the conventions of established Cashu wallets; the PoC's state list above is a behavior reference, not a required data model.

## Open Questions

- None.
