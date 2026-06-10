# Lightning & LNURL

Scope: Lightning address, BOLT11, LNURL-pay, and LNURL-withdraw payment/receive flows.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `lightning.pay-address` | Pay Lightning address | Fetches LNURL-pay invoice and pays via Cashu melt. | Scan, contact pay, standalone pay | Unknown recipient can be saved after success. |
| `lightning.pay-invoice` | Pay BOLT11 | Parses invoice, optionally confirms, then pays via Cashu melt. | Scan, paste | Auto-pay applies below configured limit. |
| `lightning.confirm-invoice` | Invoice confirmation | Shows amount/memo/expiry before payment. | Scan invoice | Needed for no-amount/large invoices. |
| `lnurl.pay` | LNURL-pay target | Loads min/max/fixed amount preview and pays. | Scan, standalone pay | Ranged amounts need validation. |
| `lnurl.withdraw` | LNURL-withdraw | Previews and confirms withdraw into Cashu. | Scan | Receive-side LNURL flow. |
| `lightning.autopay-limit` | Auto-pay limit | Pays small invoices without manual confirmation. | Advanced, scanner | Limit is configurable. |

## Flows

- `lightning.pay-address`: load LNURL-pay metadata, validate amount, fetch invoice, melt Cashu tokens, store remainder.
- `lightning.pay-invoice`: parse amount, compare auto-pay limit, confirm if needed, melt from one mint.
- `lnurl.withdraw`: preview withdraw request, confirm, mint received value.

## Contracts

- Supports Lightning addresses, BOLT11 invoices, LNURL-pay, and LNURL-withdraw.
- Cashu melt should preserve remainder tokens.
- Auto-pay must be bounded by explicit configuration.

## Open Questions

- Should auto-pay be enabled by default on mobile?
- Should LNURL-withdraw be first-release behavior?
