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

## Implementation notes (#43)

### User-facing vs support-only field split (`tx.details`, pending #59)

Decision ticket #59 is still open; until it closes, the implemented split
(apps/mobile/src/wallet/transactionsModel.ts) is:

- **User-facing**: amount, fee, date, direction, status (incl. derived
  request status), counterparty contact (links to the contact), mint
  display name (links to the mint), note, error message, payment-request
  text, LNURL success message/URL, lightning memo, lightning address.
- **Support-only** (collapsed "Support details" section, every row
  copyable, plus a copy-all JSON dump): transaction id, category/method,
  phase breadcrumb, full mint URL, source mint (consolidations), BOLT11
  invoice, payment preimage, quote id, request id, issued/used token ROW
  references.
- **Never surfaced**: serialized tokens, raw proofs, private keys. The
  writing flows never store them in `detailsJson`, and the detail/dump
  surfaces additionally whitelist every key they emit.

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
