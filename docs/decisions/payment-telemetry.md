# Decision: Payment Telemetry

Status: Accepted
Date: 2026-06-13
Issue: #60
Feature ID: `tx.telemetry`

## Decision

Payment telemetry is permanently dropped from the current Linky rewrite scope.
The app records local transaction history for user display and support context,
but it does not queue, upload, or otherwise collect anonymous payment telemetry.

## Context

The transaction feature map previously carried `tx.telemetry` as a deferred,
privacy-sensitive background feature. A repo scan found no payment telemetry
implementation or hooks to revive. The only implemented transaction surfaces are
local history rows, request status, mint/contact links, and support-safe details.

Payment flows handle real funds and may include sensitive context even after
coarsening. Adding telemetry would need a privacy review before design, not as a
background implementation detail.

## Consequences

- `tx.telemetry` is not an active feature and must not be implemented under that
  feature ID.
- Payment completion must not depend on analytics, telemetry queues, or network
  reporting.
- Local transaction history remains distinct from any future telemetry concept
  and must continue to avoid secrets, raw proofs, and private keys.
- Any future telemetry proposal needs a new feature ID and issue. Before
  implementation it must define coarse event buckets, anonymous sender identity,
  explicit privacy constraints, failure behavior that cannot block payments, and
  review ownership.
