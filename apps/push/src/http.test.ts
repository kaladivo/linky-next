import { Effect, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { PushConfig, PushConfigData } from "./config.js";
import { testConfig } from "./config.js";
import type { HttpRequest } from "./http.js";
import { handleRequest } from "./http.js";
import type { RateLimiter } from "./rateLimit.js";
import { PushStorage } from "./storage.js";
import type { TestIdentity } from "./testKit.js";
import { alice, baseLayers, bob, proofHeader } from "./testKit.js";

type TestRuntime = ManagedRuntime.ManagedRuntime<PushConfig | PushStorage | RateLimiter, never>;

describe("HTTP API (registration lifecycle + abuse limits)", () => {
  const runtimes: Array<TestRuntime> = [];
  afterEach(async () => {
    while (runtimes.length > 0) await runtimes.pop()?.dispose();
  });

  const makeRuntime = (config: PushConfigData = testConfig()) => {
    const runtime: TestRuntime = ManagedRuntime.make(baseLayers(config));
    runtimes.push(runtime);
    return { runtime, config };
  };

  const call = (runtime: TestRuntime, request: HttpRequest) =>
    runtime.runPromise(handleRequest(request));

  const registerRequest = (args: {
    config: PushConfigData;
    identity: TestIdentity;
    installationId?: string;
    token?: string;
    ip?: string;
    authorization?: string | "omit";
    nowSec?: number;
  }): HttpRequest => {
    const body = {
      recipientPubkey: args.identity.publicKeyHex,
      installationId: args.installationId ?? "install-1",
      expoPushToken: args.token ?? "ExponentPushToken[t1]",
    };
    const rawBody = JSON.stringify(body);
    const authorization =
      args.authorization === "omit"
        ? undefined
        : (args.authorization ??
          proofHeader({
            identity: args.identity,
            url: `${args.config.publicBaseUrl}/registrations`,
            method: "POST",
            body,
            ...(args.nowSec === undefined ? {} : { nowSec: args.nowSec }),
          }));
    return {
      method: "POST",
      path: "/registrations",
      authorization,
      rawBody,
      ip: args.ip ?? "1.2.3.4",
    };
  };

  const unregisterRequest = (args: {
    config: PushConfigData;
    identity: TestIdentity;
    installationId?: string;
    ip?: string;
  }): HttpRequest => {
    const body = {
      recipientPubkey: args.identity.publicKeyHex,
      installationId: args.installationId ?? "install-1",
    };
    return {
      method: "DELETE",
      path: "/registrations",
      authorization: proofHeader({
        identity: args.identity,
        url: `${args.config.publicBaseUrl}/registrations`,
        method: "DELETE",
        body,
      }),
      rawBody: JSON.stringify(body),
      ip: args.ip ?? "1.2.3.4",
    };
  };

  it("serves /health", async () => {
    const { runtime } = makeRuntime();
    const response = await call(runtime, {
      method: "GET",
      path: "/health",
      authorization: undefined,
      rawBody: "",
      ip: "1.2.3.4",
    });
    expect(response.status).toBe(200);
    expect(response.body["ok"]).toBe(true);
  });

  it("returns 404 for unknown routes", async () => {
    const { runtime } = makeRuntime();
    const response = await call(runtime, {
      method: "GET",
      path: "/nope",
      authorization: undefined,
      rawBody: "",
      ip: "1.2.3.4",
    });
    expect(response.status).toBe(404);
  });

  it("registers with a valid proof and persists the registration", async () => {
    const { runtime, config } = makeRuntime();
    const response = await call(runtime, registerRequest({ config, identity: alice }));
    expect(response).toEqual({ status: 200, body: { ok: true, replacedStaleInstalls: 0 } });
    const rows = await runtime.runPromise(
      Effect.flatMap(PushStorage, (storage) => storage.registrationsForPubkey(alice.publicKeyHex)),
    );
    expect(rows).toHaveLength(1);
  });

  it("rejects registration without a proof, and with a replayed proof", async () => {
    const { runtime, config } = makeRuntime();
    const noProof = await call(
      runtime,
      registerRequest({ config, identity: alice, authorization: "omit" }),
    );
    expect(noProof.status).toBe(401);

    const request = registerRequest({ config, identity: alice });
    expect((await call(runtime, request)).status).toBe(200);
    const replayed = await call(runtime, request);
    expect(replayed.status).toBe(401);
    expect(replayed.body["message"]).toContain("replayed");
  });

  it("rejects a proof minted for the register action on unregister", async () => {
    const { runtime, config } = makeRuntime();
    expect((await call(runtime, registerRequest({ config, identity: alice }))).status).toBe(200);

    const body = { recipientPubkey: alice.publicKeyHex, installationId: "install-1" };
    const wrongAction: HttpRequest = {
      method: "DELETE",
      path: "/registrations",
      // Signed for POST — must not authorize DELETE.
      authorization: proofHeader({
        identity: alice,
        url: `${config.publicBaseUrl}/registrations`,
        method: "POST",
        body,
      }),
      rawBody: JSON.stringify(body),
      ip: "1.2.3.4",
    };
    const response = await call(runtime, wrongAction);
    expect(response.status).toBe(401);
    expect(response.body["message"]).toContain("wrong-method");
  });

  it("rejects malformed bodies", async () => {
    const { runtime } = makeRuntime();
    const bad = await call(runtime, {
      method: "POST",
      path: "/registrations",
      authorization: undefined,
      rawBody: JSON.stringify({ recipientPubkey: "xx", installationId: "", expoPushToken: "t" }),
      ip: "1.2.3.4",
    });
    expect(bad.status).toBe(400);
    const notJson = await call(runtime, {
      method: "POST",
      path: "/registrations",
      authorization: undefined,
      rawBody: "{",
      ip: "1.2.3.4",
    });
    expect(notJson.status).toBe(400);
  });

  it("re-registering replaces the stale registration instead of duplicating", async () => {
    const { runtime, config } = makeRuntime();
    await call(
      runtime,
      registerRequest({ config, identity: alice, token: "ExponentPushToken[old]" }),
    );
    await call(
      runtime,
      registerRequest({ config, identity: alice, token: "ExponentPushToken[new]" }),
    );
    const rows = await runtime.runPromise(
      Effect.flatMap(PushStorage, (storage) => storage.registrationsForPubkey(alice.publicKeyHex)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.expoPushToken).toBe("ExponentPushToken[new]");
  });

  it("reinstall with the same device token replaces the old install", async () => {
    const { runtime, config } = makeRuntime();
    await call(
      runtime,
      registerRequest({
        config,
        identity: alice,
        installationId: "old-install",
        token: "ExponentPushToken[device]",
      }),
    );
    const response = await call(
      runtime,
      registerRequest({
        config,
        identity: alice,
        installationId: "new-install",
        token: "ExponentPushToken[device]",
      }),
    );
    expect(response.body["replacedStaleInstalls"]).toBe(1);
  });

  it("unregisters identities; the install is fully removed with the last one", async () => {
    const { runtime, config } = makeRuntime();
    await call(runtime, registerRequest({ config, identity: alice }));
    await call(runtime, registerRequest({ config, identity: bob }));

    const first = await call(runtime, unregisterRequest({ config, identity: alice }));
    expect(first.body).toEqual({ ok: true, removedIdentity: true, installRemoved: false });
    const second = await call(runtime, unregisterRequest({ config, identity: bob }));
    expect(second.body).toEqual({ ok: true, removedIdentity: true, installRemoved: true });
  });

  it("enforces the per-identity install cap with 409", async () => {
    const { runtime, config } = makeRuntime(testConfig({ maxInstallsPerIdentity: 2 }));
    for (const install of ["i1", "i2"]) {
      const ok = await call(
        runtime,
        registerRequest({
          config,
          identity: alice,
          installationId: install,
          token: `ExponentPushToken[${install}]`,
        }),
      );
      expect(ok.status).toBe(200);
    }
    const limited = await call(
      runtime,
      registerRequest({
        config,
        identity: alice,
        installationId: "i3",
        token: "ExponentPushToken[i3]",
      }),
    );
    expect(limited.status).toBe(409);
    expect(limited.body["error"]).toBe("registration_limit");
  });

  it("enforces the per-install identity cap with 409", async () => {
    const { runtime, config } = makeRuntime(testConfig({ maxIdentitiesPerInstall: 1 }));
    expect((await call(runtime, registerRequest({ config, identity: alice }))).status).toBe(200);
    const limited = await call(runtime, registerRequest({ config, identity: bob }));
    expect(limited.status).toBe(409);
  });

  it("rate limits registration attempts per IP", async () => {
    const { runtime, config } = makeRuntime(testConfig({ registerRateLimitMax: 2 }));
    // Unauthorized attempts still consume the IP budget.
    for (let i = 0; i < 2; i += 1) {
      const response = await call(
        runtime,
        registerRequest({ config, identity: alice, authorization: "omit" }),
      );
      expect(response.status).toBe(401);
    }
    const limited = await call(
      runtime,
      registerRequest({ config, identity: alice, authorization: "omit" }),
    );
    expect(limited.status).toBe(429);
    // A different IP is unaffected.
    const otherIp = await call(
      runtime,
      registerRequest({ config, identity: alice, authorization: "omit", ip: "9.9.9.9" }),
    );
    expect(otherIp.status).toBe(401);
  });

  it("rate limits registration attempts per pubkey across IPs", async () => {
    const { runtime, config } = makeRuntime(testConfig({ perPubkeyRateLimitMax: 2 }));
    for (let i = 0; i < 2; i += 1) {
      const response = await call(
        runtime,
        registerRequest({
          config,
          identity: alice,
          authorization: "omit",
          ip: `10.0.0.${i}`,
        }),
      );
      expect(response.status).toBe(401);
    }
    const limited = await call(
      runtime,
      registerRequest({ config, identity: alice, authorization: "omit", ip: "10.0.0.99" }),
    );
    expect(limited.status).toBe(429);
  });
});
