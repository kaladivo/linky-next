/**
 * Integration: boots the REAL node:http server on an ephemeral port and
 * exercises the API over the wire, NIP-98 headers included.
 */
import { Exit, ManagedRuntime, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PushConfig } from "./config.js";
import { testConfig } from "./config.js";
import type { RateLimiter } from "./rateLimit.js";
import type { PushStorage } from "./storage.js";
import { alice, baseLayers, proofHeader } from "./testKit.js";
import { serveHttp } from "./server.js";

type Deps = PushConfig | PushStorage | RateLimiter;

describe("HTTP server (integration)", () => {
  const config = testConfig();
  const runtime: ManagedRuntime.ManagedRuntime<Deps, never> = ManagedRuntime.make(
    baseLayers(config),
  );
  let scope: Scope.CloseableScope;
  let baseUrl = "";

  beforeAll(async () => {
    scope = await runtime.runPromise(Scope.make());
    const { port } = await runtime.runPromise(Scope.extend(serveHttp({ port: 0 }), scope));
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await runtime.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
  });

  const registerBody = {
    recipientPubkey: alice.publicKeyHex,
    installationId: "integration-install",
    expoPushToken: "ExponentPushToken[integration]",
  };

  it("answers /health", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("registers over the wire with a NIP-98 proof", async () => {
    const response = await fetch(`${baseUrl}/registrations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Signed against the configured public URL, like a real client.
        authorization: proofHeader({
          identity: alice,
          url: `${config.publicBaseUrl}/registrations`,
          method: "POST",
          body: registerBody,
        }),
      },
      body: JSON.stringify(registerBody),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, replacedStaleInstalls: 0 });
  });

  it("rejects a proofless registration over the wire", async () => {
    const response = await fetch(`${baseUrl}/registrations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(registerBody),
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("invalid_proof");
  });

  it("unregisters over the wire and reports full install removal", async () => {
    const body = {
      recipientPubkey: alice.publicKeyHex,
      installationId: "integration-install",
    };
    const response = await fetch(`${baseUrl}/registrations`, {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        authorization: proofHeader({
          identity: alice,
          url: `${config.publicBaseUrl}/registrations`,
          method: "DELETE",
          body,
        }),
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      removedIdentity: true,
      installRemoved: true,
    });
  });

  it("404s unknown routes", async () => {
    const response = await fetch(`${baseUrl}/nope`);
    expect(response.status).toBe(404);
  });

  it("413s oversized bodies", async () => {
    const response = await fetch(`${baseUrl}/registrations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filler: "x".repeat(70 * 1024) }),
    });
    expect(response.status).toBe(413);
  });
});
