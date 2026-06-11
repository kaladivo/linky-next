import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { CurrentEnvironment, describeEnvironment, environmentForProfile } from "../../index.js";

describe("describeEnvironment", () => {
  it("summarizes a development environment provided via a test Layer", async () => {
    const layer = Layer.succeed(CurrentEnvironment, environmentForProfile("development"));

    const summary = await Effect.runPromise(describeEnvironment.pipe(Effect.provide(layer)));

    expect(summary).toBe(
      [
        "Profile: development (test funds)",
        "Mint: https://testnut.cashu.space",
        "Relays: wss://relay.damus.io, wss://nos.lol, wss://relay.0xchat.com",
        "Sync: wss://free.evoluhq.com",
      ].join("\n"),
    );
  });

  it("marks production as mainnet funds", async () => {
    const layer = Layer.succeed(CurrentEnvironment, environmentForProfile("production"));

    const summary = await Effect.runPromise(describeEnvironment.pipe(Effect.provide(layer)));

    expect(summary).toContain("Profile: production (mainnet funds)");
    expect(summary).toContain("Mint: https://cashu.cz");
  });
});
