/**
 * The ONE ManagedRuntime of the app (docs/effect-react-bridge.md, "the
 * one-runtime rule"). Built once at module load from `appLayer` and never
 * disposed — it lives exactly as long as the JS context.
 *
 * Nothing outside src/runtime/ should import this directly: components use
 * the hooks (useEffectQuery), which close over this runtime. Creating a
 * second ManagedRuntime anywhere in the app is a bug — it would duplicate
 * every memoized service.
 */
import { ManagedRuntime } from "effect";

import { appLayer } from "./appLayer";

export const appRuntime = ManagedRuntime.make(appLayer);
