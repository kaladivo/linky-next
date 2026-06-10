# Wallet

Scope: Wallet home, balance, receive/send entry points, warnings, and amount display.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `wallet.balance` | Balance | Shows spendable and total Cashu balance. | Wallet | Display unit can cycle by tapping amount. |
| `wallet.receive` | Receive | Opens receive/top-up choices. | Wallet | Amount and no-amount receive exist. |
| `wallet.send` | Send | Opens scanner for payment targets. | Wallet | Routes Cashu, Lightning, LNURL, npub. |
| `wallet.transactions-link` | Transactions link | Opens local payment history. | Wallet | History is separate from token list. |
| `wallet.warning` | Wallet warning | Shows balance/funds warning. | Wallet | Dismissible in PoC. |
| `wallet.display-unit` | Display unit | Cycles allowed amount units. | Wallet, amount displays | Includes hidden amount mode. |

## Contracts

- Spendable balance excludes unavailable, spent, deleted, and externalized tokens.
- Amount masking must apply consistently when hidden unit is active.

## Open Questions

- Which balance warnings should survive in mobile v1?
