# Mint Management

Scope: Main mint selection, mint metadata, multi-mint balances, npub.cash hosted preference sync, and consolidation.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `mints.select-main` | Main mint | Chooses preferred mint for receive/consolidation. | Mint settings | Production and test defaults differ by env. |
| `mints.add-custom` | Custom mint | Accepts custom mint URL. | Mint settings | URL normalization matters. |
| `mints.presets` | Preset mints | Shows known standard and test mints. | Mint settings | Test mints visibly separated. |
| `mints.fetch-info` | Mint info | Caches info, fees, icon, and runtime status. | Background, mint detail | Used for display and fee hints. |
| `mints.refresh-delete` | Refresh/delete mint | Refreshes mint metadata and removes a mint after armed confirmation. | Mint detail | Deletion should not silently strand spendable funds. |
| `mints.sync-npubcash` | Hosted preference sync | Updates hosted npub.cash-compatible main mint. | Main mint change | Must fail safely. |
| `mints.melt-to-main` | Melt to main mint | Moves largest foreign-mint accepted balance to main mint. | Token list, mint settings | Retries lower amount when fees require. |
| `mints.autoswap` | Auto-swap | Debounced automatic melt to main mint. | Background | Disabled for test mints in PoC. |

## Flows

- `mints.select-main`: validate mint, optionally warn about balance swap, sync hosted preference, then persist local selection.
- `mints.melt-to-main`: choose largest non-main mint balance, pay top-up quote on main mint, store new main-mint token and remainder.

## Contracts

- Do not split one outgoing payment across mints.
- Do not persist hosted main-mint choice if hosted sync failed.
- Selecting a test mint must not silently enable production behavior.
- Mint deletion/removal should be explicit and should not imply token deletion or successful consolidation.

## Open Questions

- Does autoswap ship in first release?
- Which preset mints belong in each environment profile?
