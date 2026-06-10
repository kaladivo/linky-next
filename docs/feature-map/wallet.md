# Wallet

Scope: Wallet home, balance, receive/send entry points, warnings, and amount display.

This is the home surface of the Cashu wallet pillar. It behaves like a typical ecash wallet (balance, receive, send, history); what is Linky-specific is that "send" can also target a contact and end up in chat.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `wallet.balance` | Balance | Shows spendable and total Cashu balance. | Wallet | Display unit cycles by tapping the amount. |
| `wallet.receive` | Receive | Opens receive/top-up choices. | Wallet | Amount and no-amount receive exist. |
| `wallet.send` | Send | Opens scanner for payment targets. | Wallet | Routes Cashu, Lightning, LNURL, npub. |
| `wallet.transactions-link` | Transactions link | Opens local payment history. | Wallet | History is separate from the token list. |
| `wallet.warning` | Wallet warning | Shows a balance/funds caution. | Wallet | Mirrors the PoC warnings; dismissible. |
| `wallet.display-unit` | Display unit | Cycles allowed amount units. | Wallet, amount displays | Includes a hidden-amount mode. |

## Contracts

- Spendable balance excludes unavailable, spent, deleted, and externalized tokens.
- Amount masking must apply consistently everywhere when the hidden unit is active.

## Open Questions

- None.
