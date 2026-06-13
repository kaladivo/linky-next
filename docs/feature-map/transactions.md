# Transactions

Scope: Local payment history.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `tx.record` | Record payment event | Stores the local payment outcome. | Payment flows | Includes successes, errors, and intermediate phases. |
| `tx.list` | Transaction list | Shows payment history. | Wallet | Separate from the token list. |
| `tx.link-contact` | Contact link | Associates an event with a contact where known. | Contact pay, chat pay | Gives history context. |
| `tx.link-mint` | Mint link | Records mint and unit where known. | Cashu/Lightning flows | Helps support multi-mint behavior. |
| `tx.details` | Transaction details | Shows user-facing transaction context plus copyable support details such as mint, errors, token row references, invoice/preimage, and pay-success data. | Transaction list | Must not expose private keys, raw proofs, or serialized tokens. |
| `tx.request-status` | Request status | Shows pending/paid/declined state for payment requests. | Transaction list | Mirrors chat request outcomes. |
| `tx.merge-issued-token-spend` | Merge issued spend | Hides an emitted-token entry when that exact token is later spent successfully. | Transaction list | Emit-then-send appears as one history item. |

## Contracts

- History must not expose secrets, raw proofs, or private keys.
- Error records are valuable for support and should not be discarded.
- Payment telemetry is not implemented; `tx.telemetry` was permanently dropped by [decision #60](../decisions/payment-telemetry.md).
- Payment history avoids duplicate-looking entries for one logical emit-and-send flow.

## Dropped Features

| ID | Feature | Decision |
|---|---|---|
| `tx.telemetry` | Anonymous payment telemetry | Permanently dropped by [decision #60](../decisions/payment-telemetry.md). Any future telemetry proposal needs a new feature ID, privacy review, and explicit opt-in constraints before implementation. |

## Implementation notes (#43)

### User-facing vs support-only field split (`tx.details`, #59)

Decision: transaction details separate human-readable payment context from
copyable diagnostics (apps/mobile/src/wallet/transactionsModel.ts):

- **User-facing**: amount, fee, date, direction, status (incl. derived
  request status), counterparty contact (links to the contact), mint
  display name (links to the mint), note, error message, payment-request
  text, human-readable LNURL/pay-success message and URL, lightning memo,
  lightning address.
- **Support-only** (collapsed "Support details" section, every row
  copyable, plus a copy-all JSON dump): transaction id, category/method,
  phase breadcrumb, full mint URL, source mint (consolidations), BOLT11
  invoice, payment preimage, quote id, request id, opaque pay-success
  correlation values, issued/used token ROW references.
- **Never surfaced**: serialized Cashu tokens, raw proofs, private keys.
  Transaction writers must not store them in `detailsJson`; the
  detail/dump surfaces also whitelist every key they emit.

### PoC divergences

- The merge of issued-then-spent entries keys on `cashuToken` ROW IDS
  (`detailsJson.issuedTokenId` / `usedTokenIds`, written by #44), not on
  raw serialized token strings as in the PoC — `detailsJson` must never
  carry tokens.
- The PoC's copyable raw used/gained token strings in the details panel
  are dropped (same secrecy contract); token ROW references are shown
  instead.
- Only `completed` rows merge away. The PoC hid any row sharing a
  fulfilled request's `requestId` (including failed attempts); the rewrite
  keeps failed/pending rows visible per the error-records contract.
- Request rows and the "declined" signal are produced by #45 (not yet
  implemented): the display path renders pending/paid/declined as soon as
  rows carry the request fields; until #45 lands, no row reads declined.

## Open Questions

- None.
