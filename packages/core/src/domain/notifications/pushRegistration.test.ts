/**
 * Push registration client tests (#52): the proof-carrying request is built
 * exactly like apps/push verifies it — same URL, method, body bytes and
 * NIP-98 payload hash — and service failures map to the typed error.
 *
 * The full byte-compatibility against the REAL service verifier is pinned in
 * `apps/push/src/clientProof.compat.test.ts` (that package already depends
 * on core; the dependency cannot point the other way).
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { Effect, Encoding, Layer } from "effect";
import { describe, expect, it } from "vitest";

import type { Randomness } from "../../ports/index.js";
import { HttpClient, HttpClientError, HttpClientResponse } from "../../ports/index.js";
import { NIP98_AUTHORIZATION_SCHEME, NIP98_HTTP_AUTH_KIND } from "../mints/nip98.js";
import { decodeNostrEventOption, verifyNostrEvent } from "../nostr/NostrEvent.js";
import { hexToBytes, RandomnessFixed, TEST_SECRET_KEY_HEX } from "../nostr/nostrTestKit.js";
import { registerPushInstall, unregisterPushInstall } from "./pushRegistration.js";

const SECRET_KEY = hexToBytes(TEST_SECRET_KEY_HEX);
const PUBKEY_HEX = Encoding.encodeHex(schnorr.getPublicKey(SECRET_KEY));
const SERVICE_URL = "http://localhost:8787";

interface CapturedRequest {
  url: string;
  method: string;
  authorization: string | undefined;
  bodyText: string | undefined;
}

const bodyTextOf = (request: { readonly body: unknown }): string | undefined => {
  const body = request.body as { _tag?: string; body?: unknown };
  if (body?._tag === "Uint8Array" && body.body instanceof Uint8Array) {
    return new TextDecoder().decode(body.body);
  }
  return undefined;
};

/** Stub HttpClient: captures the request, answers with the given response. */
const stubHttp = (
  captured: CapturedRequest[],
  status: number,
  responseBody: Record<string, unknown>,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        captured.push({
          url: request.url,
          method: request.method,
          authorization: request.headers["authorization"],
          bodyText: bodyTextOf(request),
        });
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(responseBody), {
            status,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    ),
  );

const run = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient | Randomness>,
  http: Layer.Layer<HttpClient.HttpClient>,
) => Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(http, RandomnessFixed))));

const registerArgs = {
  serviceUrl: SERVICE_URL,
  recipientPubkeyHex: PUBKEY_HEX,
  secretKey: SECRET_KEY,
  installationId: "test-install-1",
  expoPushToken: "ExponentPushToken[unit-test-token]",
};

describe("registerPushInstall", () => {
  it("sends the proof-carrying request the service verifies", async () => {
    const captured: CapturedRequest[] = [];
    const result = await run(
      registerPushInstall(registerArgs),
      stubHttp(captured, 200, { ok: true, replacedStaleInstalls: 2 }),
    );

    expect(result).toEqual({ replacedStaleInstalls: 2 });
    expect(captured).toHaveLength(1);
    const request = captured[0]!;
    expect(request.url).toBe(`${SERVICE_URL}/registrations`);
    expect(request.method).toBe("POST");

    // Body: exactly the JSON the proof hashed, with the registration fields.
    expect(request.bodyText).toBeDefined();
    expect(JSON.parse(request.bodyText!)).toEqual({
      recipientPubkey: PUBKEY_HEX,
      installationId: "test-install-1",
      expoPushToken: "ExponentPushToken[unit-test-token]",
    });

    // Authorization: a valid NIP-98 event signed by the registered identity,
    // pinning URL + method + the sha256 of the exact body bytes — the same
    // checks apps/push's verifyRegistrationProof performs.
    expect(request.authorization).toBeDefined();
    expect(request.authorization!.startsWith(NIP98_AUTHORIZATION_SCHEME)).toBe(true);
    const eventJson: unknown = JSON.parse(
      new TextDecoder().decode(
        Encoding.decodeBase64(
          request.authorization!.slice(NIP98_AUTHORIZATION_SCHEME.length),
        ).pipe((either) => (either._tag === "Right" ? either.right : new Uint8Array())),
      ),
    );
    const decoded = decodeNostrEventOption(eventJson);
    expect(decoded._tag).toBe("Some");
    const event = decoded._tag === "Some" ? decoded.value : null;
    expect(event!.kind).toBe(NIP98_HTTP_AUTH_KIND);
    expect(event!.pubkey).toBe(PUBKEY_HEX);
    expect(verifyNostrEvent(event!)).toBe(true);
    const tag = (name: string) => event!.tags.find((entry) => entry[0] === name)?.[1];
    expect(tag("u")).toBe(`${SERVICE_URL}/registrations`);
    expect(tag("method")).toBe("POST");
    expect(tag("payload")).toBe(
      Encoding.encodeHex(sha256(new TextEncoder().encode(request.bodyText!))),
    );
  });

  it("strips a trailing slash from the service URL before signing", async () => {
    const captured: CapturedRequest[] = [];
    await run(
      registerPushInstall({ ...registerArgs, serviceUrl: `${SERVICE_URL}/` }),
      stubHttp(captured, 200, { ok: true, replacedStaleInstalls: 0 }),
    );
    expect(captured[0]!.url).toBe(`${SERVICE_URL}/registrations`);
  });

  it("maps service rejections to the typed error (429 rate_limited)", async () => {
    const failure = await run(
      Effect.flip(registerPushInstall(registerArgs)),
      stubHttp([], 429, { error: "rate_limited", message: "Too many requests" }),
    );
    expect(failure._tag).toBe("PushRegistrationError");
    const error = failure as { status: number | null; code: string | null; reason: string };
    expect(error.status).toBe(429);
    expect(error.code).toBe("rate_limited");
    expect(error.reason).toBe("Too many requests");
  });

  it("maps transport failures to status null (nothing reached the service)", async () => {
    const offline = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.RequestError({
            request,
            reason: "Transport",
            description: "socket hang up",
          }),
        ),
      ),
    );
    const failure = await run(Effect.flip(registerPushInstall(registerArgs)), offline);
    expect(failure._tag).toBe("PushRegistrationError");
    expect((failure as { status: number | null }).status).toBeNull();
  });
});

describe("unregisterPushInstall", () => {
  it("sends DELETE with the two-field body and maps the result", async () => {
    const captured: CapturedRequest[] = [];
    const result = await run(
      unregisterPushInstall({
        serviceUrl: SERVICE_URL,
        recipientPubkeyHex: PUBKEY_HEX,
        secretKey: SECRET_KEY,
        installationId: "test-install-1",
      }),
      stubHttp(captured, 200, { ok: true, removedIdentity: true, installRemoved: true }),
    );
    expect(result).toEqual({ removedIdentity: true, installRemoved: true });
    const request = captured[0]!;
    expect(request.method).toBe("DELETE");
    expect(JSON.parse(request.bodyText!)).toEqual({
      recipientPubkey: PUBKEY_HEX,
      installationId: "test-install-1",
    });
  });
});
