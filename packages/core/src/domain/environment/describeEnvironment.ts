/**
 * describeEnvironment — a deliberately trivial workflow that reads the
 * `CurrentEnvironment` service and renders a human-readable summary.
 *
 * It exists as the reference example for the Effect ↔ React bridge
 * (docs/effect-react-bridge.md): the mobile app runs it through the app
 * `ManagedRuntime` via a hook and shows the result on the Settings screen.
 * The inferred type documents the contract: cannot fail (`never` in E),
 * needs only `CurrentEnvironment` in R.
 */
import { Effect } from "effect";

import { CurrentEnvironment } from "./CurrentEnvironment.js";

/**
 * Summary of the running environment, one fact per line:
 * profile + funds network, mint, relays, sync servers.
 */
export const describeEnvironment: Effect.Effect<string, never, CurrentEnvironment> = Effect.gen(
  function* () {
    const env = yield* CurrentEnvironment;
    return [
      `Profile: ${env.profile} (${env.network === "main" ? "mainnet funds" : "test funds"})`,
      `Mint: ${env.cashuMintUrl}`,
      `Relays: ${env.nostrRelayUrls.join(", ")}`,
      `Sync: ${env.evoluSyncUrls.join(", ")}`,
    ].join("\n");
  },
);
