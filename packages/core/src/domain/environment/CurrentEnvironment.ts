/**
 * CurrentEnvironment — the decoded `EnvironmentConfig` of the running app,
 * available to workflows as an Effect service.
 *
 * Core owns the service definition (this tag); the app owns the value: at
 * startup `apps/mobile` decodes the build profile into an
 * `EnvironmentConfig` and provides it to the single app `ManagedRuntime`
 * via `Layer.succeed(CurrentEnvironment, environment)`. Tests provide a
 * config built with `environmentForProfile(...)` (or a hand-rolled one
 * through `decodeEnvironmentConfig`) the same way.
 *
 * Unlike the I/O ports in `src/ports/`, the service here is plain data —
 * the validated config itself — so there is no separate `...Service`
 * interface and no error type: reading configuration cannot fail.
 */
import { Context } from "effect";

import type { EnvironmentConfig } from "./EnvironmentConfig.js";

export class CurrentEnvironment extends Context.Tag("@linky/core/CurrentEnvironment")<
  CurrentEnvironment,
  EnvironmentConfig
>() {}
