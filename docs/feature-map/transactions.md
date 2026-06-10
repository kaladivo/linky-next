# Transactions

Scope: Local payment history and payment telemetry.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `tx.record` | Record payment event | Stores the local payment outcome. | Payment flows | Includes successes, errors, and intermediate phases. |
| `tx.list` | Transaction list | Shows payment history. | Wallet | Separate from the token list. |
| `tx.link-contact` | Contact link | Associates an event with a contact where known. | Contact pay, chat pay | Gives history context. |
| `tx.link-mint` | Mint link | Records mint and unit where known. | Cashu/Lightning flows | Helps support multi-mint behavior. |
| `tx.details` | Transaction details | Shows copyable support details such as mint, errors, tokens, invoice/preimage, and pay-success data. | Transaction list | Must not expose private keys or raw proofs. The user-facing vs support-only field split is decided and documented during implementation (track with a ticket). |
| `tx.request-status` | Request status | Shows pending/paid/declined state for payment requests. | Transaction list | Mirrors chat request outcomes. |
| `tx.merge-issued-token-spend` | Merge issued spend | Hides an emitted-token entry when that exact token is later spent successfully. | Transaction list | Emit-then-send appears as one history item. |
| `tx.telemetry` | Anonymous telemetry | Queues anonymized payment telemetry. | Background | Dropped for now; create a ticket during implementation to decide later. Privacy-sensitive. |

## Contracts

- History must not expose secrets, raw proofs, or private keys.
- Error records are valuable for support and should not be discarded.
- If telemetry is ever revived, it stays distinct from local transaction history, must not block payment completion, and uses coarse buckets with anonymous sender identity.
- Payment history avoids duplicate-looking entries for one logical emit-and-send flow.

## Open Questions

- None.
