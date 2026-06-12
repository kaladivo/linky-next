/**
 * syncTestKit — shared utilities for the sync domain tests ONLY.
 *
 * Excluded from the build (`tsconfig.build.json` excludes test support);
 * never exported from the package. Mirrors `nostrTestKit.ts`.
 */
import { Layer } from "effect";

import { CurrentEnvironment } from "../environment/CurrentEnvironment.js";
import { decodeEnvironmentConfig } from "../environment/EnvironmentConfig.js";

/** A `CurrentEnvironment` Layer with the given sync server defaults. */
export const syncTestEnvironmentLayer = (
  evoluSyncUrls: readonly [string, ...Array<string>],
): Layer.Layer<CurrentEnvironment> =>
  Layer.succeed(
    CurrentEnvironment,
    decodeEnvironmentConfig({
      profile: "development",
      network: "test",
      cashuMintUrl: "https://testnut.cashu.space",
      presetMintUrls: ["https://testnut.cashu.space"],
      nostrRelayUrls: ["wss://relay-a.test"],
      evoluSyncUrls,
      pushServiceUrl: "http://localhost:8787",
    }),
  );
