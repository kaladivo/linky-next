# Lightning & LNURL

Scope: Lightning address, BOLT11 invoice, LNURL-pay, and LNURL-withdraw payment/receive flows.

Standard Lightning-via-ecash pattern, as in other Cashu wallets: receiving mints ecash, paying melts ecash. The user sees a Lightning wallet; the balance is always Cashu.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `lightning.pay-address` | Pay Lightning address | Fetches an invoice for the address and pays it from the Cashu wallet. | Scan, contact pay, standalone pay | Unknown recipient can be saved as a contact after success. |
| `lightning.pay-invoice` | Pay BOLT11 | Parses an invoice, optionally confirms, then pays from the Cashu wallet. | Scan, paste | Auto-pay applies below the configured limit. |
| `lightning.confirm-invoice` | Invoice confirmation | Shows amount/memo/expiry before payment. | Scan invoice | Needed for no-amount and large invoices. |
| `lnurl.pay` | LNURL-pay target | Loads min/max/fixed amount preview and pays. | Scan, standalone pay | Ranged amounts need validation. |
| `lnurl.withdraw` | LNURL-withdraw | Previews and confirms a withdraw into the wallet. | Scan | First-release behavior. Receive-side LNURL flow. |
| `lightning.autopay-limit` | Auto-pay limit | Pays small invoices without manual confirmation. | Advanced, scanner | Enabled by default; limit is user-configurable. |

## Flows

- `lightning.pay-address`: load pay metadata, validate amount, fetch invoice, pay from wallet, keep any remainder.
- `lightning.pay-invoice`: parse amount, compare to auto-pay limit, confirm if needed, pay from a single mint.
- `lnurl.withdraw`: preview the withdraw offer, confirm, receive value into the wallet.

## Contracts

- Supports Lightning addresses, BOLT11 invoices, LNURL-pay, and LNURL-withdraw.
- Paying from the Cashu wallet must preserve remainder value.
- Auto-pay is on by default but always bounded by a user-configurable limit.

## Open Questions

- None.
