/**
 * Data & Sync domain (#53): user-editable sync-server list and per-server
 * reachability status. Evolu-specific wiring (applying the list as store
 * transports) stays in `@linky/evolu-store` / the app — core only owns the
 * settings and the probes.
 */
export * from "./syncServerSettings.js";
export * from "./syncServerStatus.js";
