/**
 * Cashu wallet engine (issue #32) — deterministic seed/counters, token
 * lifecycle (receive / send / melt / top-up), proof-state validation and
 * deterministic restore. Built on cashu-ts 2.9.0 (the PoC's exact resolved
 * version; v2-lts) with all network traffic injected through the HttpClient
 * port and all counter state behind the CounterStore port.
 */
export * from "./errors.js";
export * from "./tokenCodec.js";
export * from "./proofStates.js";
export * from "./receiveToken.js";
export * from "./sendToken.js";
export * from "./meltToken.js";
export * from "./topup.js";
export * from "./restore.js";
// Intentionally not exported (internal): `internal/transport.js` (HttpClient
// → cashu-ts request bridge), `internal/wallet.js` (loaded wallet handles +
// mint-compatibility fallback), `internal/deterministic.js` (counter retry
// constants, token/mint decode guard, blank-output math).
