/**
 * Data & Sync domain: user-editable sync-server list and per-server
 * reachability status (#53), plus the pure, convergent storage-rotation
 * decision logic (`sync.storage-rotation`, #54). Evolu-specific wiring
 * (applying the list as store transports, the rotation storage side)
 * stays in `@linky/evolu-store` / the app — core only owns settings,
 * probes, and rules.
 */
export * from "./storageRotation.js";
export * from "./syncServerSettings.js";
export * from "./syncServerStatus.js";
