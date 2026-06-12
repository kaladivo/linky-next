/**
 * Client ↔ service compatibility (#52): core's REAL mobile registration
 * client (`registerPushInstall` / `unregisterPushInstall`) is routed through
 * a stub HttpClient straight into this service's `handleRequest` — proving
 * the client-built NIP-98 proof, body bytes and URL are byte-compatible with
 * `verifyRegistrationProof` (no mocked verifier anywhere).
 */
import type { HttpClient as HttpClientType } from "@linky/core";
import {
  HttpClient,
  HttpClientResponse,
  registerPushInstall,
  unregisterPushInstall,
} from "@linky/core";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { PushConfig, PushConfigData } from "./config.js";
import { testConfig } from "./config.js";
import { handleRequest } from "./http.js";
import type { RateLimiter } from "./rateLimit.js";
import { PushStorage } from "./storage.js";
import { alice, baseLayers, RandomnessCounter } from "./testKit.js";

type ServiceRuntime = ManagedRuntime.ManagedRuntime<PushConfig | PushStorage | RateLimiter, never>;

const bodyTextOf = (request: { readonly body: unknown }): string => {
  const body = request.body as { _tag?: string; body?: unknown };
  if (body?._tag === "Uint8Array" && body.body instanceof Uint8Array) {
    return new TextDecoder().decode(body.body);
  }
  return "";
};

/** HttpClient Layer that delivers requests into the service's handler. */
const serviceBackedHttp = (
  runtime: ServiceRuntime,
  baseUrl: string,
): Layer.Layer<HttpClientType.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.promise(async () => {
        if (!request.url.startsWith(baseUrl)) throw new Error(`unexpected url ${request.url}`);
        const response = await runtime.runPromise(
          handleRequest({
            method: request.method,
            path: request.url.slice(baseUrl.length),
            authorization: request.headers["authorization"],
            rawBody: bodyTextOf(request),
            ip: "10.0.0.1",
          }),
        );
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(response.body), {
            status: response.status,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    ),
  );

describe("core client against the real service verifier", () => {
  const runtimes: Array<ServiceRuntime> = [];
  afterEach(async () => {
    while (runtimes.length > 0) await runtimes.pop()?.dispose();
  });

  const makeService = (config: PushConfigData = testConfig()) => {
    const runtime: ServiceRuntime = ManagedRuntime.make(baseLayers(config));
    runtimes.push(runtime);
    return {
      runtime,
      config,
      clientLayers: Layer.mergeAll(
        serviceBackedHttp(runtime, config.publicBaseUrl),
        RandomnessCounter,
      ),
    };
  };

  const clientArgs = (config: PushConfigData) => ({
    serviceUrl: config.publicBaseUrl,
    recipientPubkeyHex: alice.publicKeyHex,
    secretKey: alice.secretKey,
    installationId: "compat-install-1",
  });

  it("register → verify stored → unregister round-trips", async () => {
    const { runtime, config, clientLayers } = makeService();

    const registered = await Effect.runPromise(
      registerPushInstall({
        ...clientArgs(config),
        expoPushToken: "ExponentPushToken[compat-1]",
      }).pipe(Effect.provide(clientLayers)),
    );
    expect(registered).toEqual({ replacedStaleInstalls: 0 });

    const rows = await runtime.runPromise(
      Effect.gen(function* () {
        const storage = yield* PushStorage;
        return yield* storage.registrationsForPubkey(alice.publicKeyHex);
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expoPushToken).toBe("ExponentPushToken[compat-1]");

    const unregistered = await Effect.runPromise(
      unregisterPushInstall(clientArgs(config)).pipe(Effect.provide(clientLayers)),
    );
    expect(unregistered).toEqual({ removedIdentity: true, installRemoved: true });

    const after = await runtime.runPromise(
      Effect.gen(function* () {
        const storage = yield* PushStorage;
        return yield* storage.registrationsForPubkey(alice.publicKeyHex);
      }),
    );
    expect(after).toHaveLength(0);
  });

  it("re-registering replaces a reinstall's stale install (replace-stale)", async () => {
    const { config, clientLayers } = makeService();
    const token = "ExponentPushToken[compat-same-device]";

    await Effect.runPromise(
      registerPushInstall({
        ...clientArgs(config),
        installationId: "old-install",
        expoPushToken: token,
      }).pipe(Effect.provide(clientLayers)),
    );
    // Reinstall: fresh install id, same device token → old install replaced.
    const second = await Effect.runPromise(
      registerPushInstall({
        ...clientArgs(config),
        installationId: "new-install",
        expoPushToken: token,
      }).pipe(Effect.provide(clientLayers)),
    );
    expect(second.replacedStaleInstalls).toBe(1);
  });

  it("a proof signed for another service URL is rejected (401 invalid_proof)", async () => {
    const { runtime, config } = makeService();
    // Client believes the service lives elsewhere → `u` tag mismatch.
    const wrongUrlLayers = Layer.mergeAll(
      serviceBackedHttp(runtime, "http://push.wrong"),
      RandomnessCounter,
    );
    const failure = await Effect.runPromise(
      Effect.flip(
        registerPushInstall({
          ...clientArgs(config),
          serviceUrl: "http://push.wrong",
          expoPushToken: "ExponentPushToken[compat-x]",
        }).pipe(Effect.provide(wrongUrlLayers)),
      ),
    );
    expect(failure._tag).toBe("PushRegistrationError");
    const error = failure as { status: number | null; code: string | null };
    expect(error.status).toBe(401);
    expect(error.code).toBe("invalid_proof");
  });

  it("per-pubkey rate limit surfaces as 429 rate_limited", async () => {
    const { config, clientLayers } = makeService(
      testConfig({ perPubkeyRateLimitMax: 1, perPubkeyRateLimitWindowMs: 60_000 }),
    );
    await Effect.runPromise(
      registerPushInstall({
        ...clientArgs(config),
        expoPushToken: "ExponentPushToken[compat-rl]",
      }).pipe(Effect.provide(clientLayers)),
    );
    const failure = await Effect.runPromise(
      Effect.flip(
        registerPushInstall({
          ...clientArgs(config),
          expoPushToken: "ExponentPushToken[compat-rl]",
        }).pipe(Effect.provide(clientLayers)),
      ),
    );
    expect(failure._tag).toBe("PushRegistrationError");
    expect((failure as { status: number | null }).status).toBe(429);
    expect((failure as { code: string | null }).code).toBe("rate_limited");
  });
});
