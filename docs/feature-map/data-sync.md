# Data & Sync

Scope: Local-first data, cross-device sync, sync servers, and data maintenance.

Supporting layer, not a product pillar. It is mostly invisible: its job is that both pillars work offline, survive restore, and stay consistent across the user's devices. Only its settings/diagnostics surfaces are user-visible.

## Features

| ID | Feature | What It Does | Entry Points | Notes |
|---|---|---|---|---|
| `sync.local-data` | Local data | Keeps all app data usable on the device without connectivity. | Whole app | Foundation of the local-first feel. |
| `sync.cross-device` | Cross-device sync | Syncs data between devices restored from the same backup. | Background | Contacts, wallet, messages, and history converge. |
| `sync.servers` | Sync servers | Lets user add, remove, and disable sync servers. | Advanced/settings | User-facing/dev-only split mirrors the PoC. Defaults must work without configuration. |
| `sync.status` | Sync status | Shows connected/checking/disconnected per server and overall. | Advanced/settings | |
| `sync.domain-separation` | Domain separation | Syncs contacts, wallet, messages, transactions, identity, and meta data as separate domains. | Storage | Restore reconnects every domain. |
| `sync.storage-rotation` | Storage rotation | Periodically moves writes to fresh sync storage while keeping older data readable. | Background, debug | Invisible to the user; rotation decisions converge across devices. Manual rotation stays dev-only, as in the PoC. Also what bounds chat storage now that message caps are gone (see Chat). |
| `sync.inspect-data` | Data inspection | Shows raw current and historical data. | Debug | Dev/support only. |
| `sync.clear-local` | Clear local data | Wipes local data on this device. | Debug/settings | Dangerous support action. |

## Contracts

- Sync identities derive deterministically from the master identity, so restore reconnects all synced data.
- The app stays fully usable offline.
- Storage maintenance/rotation never makes existing contacts, tokens, messages, or history disappear.
- Devices sharing the same account converge to the same data.
- Clearing local data is destructive and needs explicit intent.

## Open Questions

- None.
