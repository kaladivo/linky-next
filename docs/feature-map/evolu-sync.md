# Evolu Sync

Scope: Local-first data, sync servers, owner lanes, owner rotation, and diagnostics.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `evolu.local-store` | Local store | Stores app data locally. | Whole app | SQLite/Evolu in PoC. |
| `evolu.sync-servers` | Sync servers | Configures Evolu server URLs. | Advanced/settings | Servers can be added, removed, disabled. |
| `evolu.status` | Sync status | Shows connected/checking/disconnected. | Advanced/settings | Server-specific and overall status. |
| `evolu.owner-lanes` | Owner lanes | Separates data ownership by domain. | Storage | Contacts, cashu, messages, transactions, identity, meta. |
| `evolu.owner-rotation` | Owner rotation | Moves writes to new deterministic owner lanes. | Background/debug | Pointer-only rotation; old lanes stay readable. |
| `evolu.aggregate-lanes` | Aggregate lane reads | Reads visible historical lanes for each domain. | App data reads | Prevents old contacts/tokens/messages/transactions disappearing after rotation. |
| `evolu.rotation-counters` | Rotation counters | Derives remaining lane budget from local Evolu history plus synced snapshots. | Background | Avoids divergent per-browser edit counters. |
| `evolu.current-data` | Current data viewer | Shows current rows and owner diagnostics. | Debug | Dev/support only. |
| `evolu.history-data` | History viewer | Shows Evolu history rows. | Debug | Dev/support only. |
| `evolu.clear-local` | Clear local database | Clears local data. | Debug/settings | Dangerous support action. |

## Contracts

- Evolu owner lanes are deterministic from the master identity.
- Local-first app state should work offline.
- Owner rotation must not make existing useful data disappear.
- Writes should go to the active lane while reads include older visible lanes for the same domain.
- Rotation decisions should converge across devices with the same synced Evolu history.
- Clearing local data is a destructive support action and needs explicit intent.

## Open Questions

- Which server-management controls are user-facing vs dev-only?
- Should manual owner rotation survive outside dev builds?
