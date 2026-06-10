# Transactions

Scope: Local payment history and payment telemetry.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `tx.record` | Record payment event | Stores local payment outcome. | Payment flows | Includes successes, errors, and phases. |
| `tx.list` | Transaction list | Shows payment history. | Wallet | Separate from token list. |
| `tx.link-contact` | Contact link | Associates event with contact where known. | Contact pay, chat pay | Useful for history context. |
| `tx.link-mint` | Mint link | Records mint and unit where known. | Cashu/Lightning flows | Helps support multi-mint behavior. |
| `tx.details` | Transaction details | Shows copyable support details such as mint, errors, tokens, invoice/preimage, and LNURL success data. | Transaction list | Must not expose private keys or raw proofs. |
| `tx.request-status` | Request status | Shows pending/paid/declined state for payment requests. | Transaction list | Mirrors chat request outcomes. |
| `tx.merge-issued-token-spend` | Merge issued spend | Hides an emitted-token row when the exact token is later spent successfully. | Transaction list | Emit-then-send appears as one history item. |
| `tx.telemetry` | Anonymous telemetry | Queues anonymized payment telemetry. | Background | Privacy-sensitive. |

## Contracts

- History must not expose secrets, raw proofs, or private keys.
- Error records are useful and should not be discarded.
- Telemetry is distinct from local transaction history.
- Telemetry must not block payment completion and should use coarse buckets/anonymous sender identity.
- Payment history should avoid duplicate-looking entries for one logical emit-and-send flow.

## Open Questions

- Is anonymous telemetry part of the rewrite or dropped?
- What history fields are user-facing vs support-only?
