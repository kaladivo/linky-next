/**
 * `mints.sync-hosted` over a stubbed HttpClient: wire format (PUT, body
 * bytes, NIP-98 header), hosted-server selection by Lightning-address
 * domain, and the fail-safe error paths the select-main flow depends on.
 */
import { Effect, Either, Encoding } from "effect";
import { describe, expect, it } from "vitest";

import type { Randomness } from "../../ports/Randomness.js";
import type { NostrEvent } from "../nostr/NostrEvent.js";
import { verifyNostrEvent } from "../nostr/NostrEvent.js";
import { RandomnessFixed, hexToBytes } from "../nostr/nostrTestKit.js";
import { syncHostedMintPreference } from "./syncHostedMintPreference.js";
import { mintsHttpStub, ok } from "./__tests__/mintsTestKit.js";

const SECRET_KEY = hexToBytes(
  "91359bc27d67c1238d6a61d83709ebfdf12749bf47747b9f0a326839fb41034f",
);

const run = <A, E>(effect: Effect.Effect<A, E, Randomness>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(RandomnessFixed)));

describe("syncHostedMintPreference", () => {
  it("PUTs the canonical mint to the linky.fit hosted server with NIP-98 auth", async () => {
    const stub = mintsHttpStub([["https://npub.linky.fit/api/v1/info/mint", () => ok({ ok: true })]]);
    const result = await run(
      syncHostedMintPreference({
        mintUrl: "https://CASHU.cz/",
        lightningAddress: "npub1alice@linky.fit",
        nostrSecretKey: SECRET_KEY,
      }).pipe(Effect.provide(stub.layer)),
    );

    expect(result).toEqual({ baseUrl: "https://npub.linky.fit", mintUrl: "https://cashu.cz" });
    expect(stub.requests).toHaveLength(1);
    const request = stub.requests[0]!;
    expect(request.method).toBe("PUT");
    expect(request.url).toBe("https://npub.linky.fit/api/v1/info/mint");
    expect(request.bodyText).toBe('{"mintUrl":"https://cashu.cz"}'); // exact PoC bytes
    expect(request.bodyContentType).toBe("application/json");

    const authorization = request.headers["authorization"] ?? "";
    expect(authorization.startsWith("Nostr ")).toBe(true);
    const event = JSON.parse(
      Either.getOrThrow(Encoding.decodeBase64String(authorization.slice("Nostr ".length))),
    ) as NostrEvent;
    expect(event.kind).toBe(27235);
    expect(event.tags[0]).toEqual(["u", "https://npub.linky.fit/api/v1/info/mint"]);
    expect(event.tags[1]).toEqual(["method", "PUT"]);
    expect(event.tags[2]?.[0]).toBe("payload");
    expect(verifyNostrEvent(event)).toBe(true);
  });

  it("defaults to npub.cash for non-hosted (or missing) addresses", async () => {
    const stub = mintsHttpStub([["https://npub.cash/api/v1/info/mint", () => ok({})]]);
    const result = await run(
      syncHostedMintPreference({
        mintUrl: "https://testnut.cashu.space",
        lightningAddress: null,
        nostrSecretKey: SECRET_KEY,
      }).pipe(Effect.provide(stub.layer)),
    );
    expect(result.baseUrl).toBe("https://npub.cash");
  });

  it("fails typed on a non-2xx response (selection must NOT persist)", async () => {
    const stub = mintsHttpStub([
      ["https://npub.linky.fit/api/v1/info/mint", () => ({ status: 401, body: {} })],
    ]);
    const error = await run(
      syncHostedMintPreference({
        mintUrl: "https://cashu.cz",
        lightningAddress: "a@linky.fit",
        nostrSecretKey: SECRET_KEY,
      }).pipe(Effect.provide(stub.layer), Effect.flip),
    );
    expect(error._tag).toBe("HostedMintSyncError");
    expect(error._tag === "HostedMintSyncError" && error.status).toBe(401);
  });

  it("fails typed on transport failure", async () => {
    const stub = mintsHttpStub([
      ["https://npub.linky.fit/api/v1/info/mint", () => ({ status: -1, body: null })],
    ]);
    const error = await run(
      syncHostedMintPreference({
        mintUrl: "https://cashu.cz",
        lightningAddress: "a@linky.fit",
        nostrSecretKey: SECRET_KEY,
      }).pipe(Effect.provide(stub.layer), Effect.flip),
    );
    expect(error._tag).toBe("HostedMintSyncError");
    expect(error._tag === "HostedMintSyncError" && error.status).toBeNull();
  });

  it("rejects invalid mint URLs before any network traffic", async () => {
    const stub = mintsHttpStub([]);
    const error = await run(
      syncHostedMintPreference({
        mintUrl: "not a url",
        lightningAddress: "a@linky.fit",
        nostrSecretKey: SECRET_KEY,
      }).pipe(Effect.provide(stub.layer), Effect.flip),
    );
    expect(error._tag).toBe("InvalidMintUrlError");
    expect(stub.requests).toHaveLength(0);
  });
});
