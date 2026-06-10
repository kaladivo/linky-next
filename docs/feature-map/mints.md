# Mints

Scope: Main mint selection, mint metadata, multi-mint balances, hosted address preference sync, and consolidation.

Multi-mint handling follows common Cashu wallet patterns. Linky is opinionated on top of them: one strong "main mint" preference, automatic consolidation toward it, and the main mint kept in sync with the hosted Lightning address service.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `mints.select-main` | Main mint | Chooses the preferred mint for receive and consolidation. | Mint settings | Defaults are configurable per environment via env vars; for now `cashu.cz` in production and `testnut.cashu.space` in development. |
| `mints.add-custom` | Custom mint | Accepts a custom mint URL. | Mint settings | URL normalization matters. |
| `mints.presets` | Preset mints | Shows known standard and test mints. | Mint settings | Test mints are visibly separated. |
| `mints.fetch-info` | Mint info | Caches mint info, fees, icon, and reachability status. | Background, mint detail | Used for display and fee hints. |
| `mints.refresh-delete` | Refresh/delete mint | Refreshes mint metadata and removes a mint after armed confirmation. | Mint detail | Deletion must not silently strand spendable funds. |
| `mints.sync-hosted` | Hosted preference sync | Updates the hosted Lightning-address service (npub.cash-compatible) with the chosen main mint. | Main mint change | Must fail safely. |
| `mints.melt-to-main` | Consolidate to main mint | Moves the largest foreign-mint balance to the main mint. | Token list, mint settings | Retries a lower amount when fees require it. |
| `mints.autoswap` | Auto-consolidation | Automatically consolidates foreign-mint balance to the main mint. | Background | Follows how established Cashu wallets handle consolidation. Disabled for test mints in PoC. |

## Flows

- `mints.select-main`: validate mint, optionally warn about balance consolidation, sync hosted preference, then persist the local selection.
- `mints.melt-to-main`: choose the largest non-main mint balance, move it into the main mint, keep the new balance and any remainder.

## Contracts

- One outgoing payment never splits across mints.
- The hosted main-mint choice is not persisted locally if hosted sync failed.
- Selecting a test mint must not silently enable real-funds behavior.
- Removing a mint is explicit and does not imply token deletion or successful consolidation.
- Preset mints per environment are configurable via env vars, not hard-coded.

## Open Questions

- None.
