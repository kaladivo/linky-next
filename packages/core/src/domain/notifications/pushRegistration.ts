/**
 * Push registration client (`notifications.enable` / `notifications.disable`
 * / `notifications.replace-stale`, issue #52) — the mobile side of
 * apps/push's registration API (#51).
 *
 * One request registers ONE identity (recipient pubkey) on one install; the
 * service replaces stale state instead of duplicating (same identity+install
 * updates the token in place; other installs holding the same device token —
 * an app reinstall — are deleted, see apps/push/README.md).
 *
 * Ownership proof: NIP-98 (kind 27235) via `buildNip98Token` — the exact
 * token format apps/push verifies byte-for-byte. The proof pins the absolute
 * URL, the HTTP method and the sha256 of the EXACT request body, so the body
 * sent on the wire must be the same `JSON.stringify(payload)` the token
 * hashed; this module builds both from one object to make divergence
 * impossible (`apps/push/src/clientProof.compat.test.ts` pins the
 * compatibility against the real verifier).
 *
 * Privacy contract (notifications.md): the service only ever learns the
 * recipient pubkey, an install id and the Expo push token. No decryption
 * material is part of any request — rich notification copy is produced
 * on-device.
 */
import { Clock, Data, Effect } from "effect";

import { HttpClient, HttpClientRequest } from "../../ports/Http.js";
import type { Randomness, RandomnessError } from "../../ports/Randomness.js";
import { buildNip98Token } from "../mints/nip98.js";

/** Registration resource path on the push service. */
export const PUSH_REGISTRATIONS_PATH = "/registrations";

/**
 * One push-service request failure. `status === null` means the transport
 * failed (offline, DNS, refused) — nothing reached the service. `code` is
 * the service's machine-readable error (`invalid_proof`, `rate_limited`,
 * `registration_limit`, …) when a JSON error body was returned.
 */
export class PushRegistrationError extends Data.TaggedError("PushRegistrationError")<{
  readonly url: string;
  readonly status: number | null;
  readonly code: string | null;
  readonly reason: string;
}> {}

export interface PushInstallIdentity {
  /** Push service base URL (no trailing slash; from EnvironmentConfig). */
  readonly serviceUrl: string;
  /** Hex pubkey of the identity being (un)registered — signs the proof. */
  readonly recipientPubkeyHex: string;
  /** 32-byte Nostr secret key of the SAME identity. */
  readonly secretKey: Uint8Array;
  /** Client-generated stable install id (`[A-Za-z0-9._-]{1,128}`). */
  readonly installationId: string;
}

export interface RegisterPushInstallArgs extends PushInstallIdentity {
  /** Expo push token (`ExponentPushToken[...]`). */
  readonly expoPushToken: string;
}

export interface RegisterPushInstallResult {
  /** Other installs that held the same device token and were removed. */
  readonly replacedStaleInstalls: number;
}

export interface UnregisterPushInstallResult {
  readonly removedIdentity: boolean;
  /** True when this was the install's last identity (install fully gone). */
  readonly installRemoved: boolean;
}

const registrationsUrl = (serviceUrl: string): string =>
  `${serviceUrl.replace(/\/+$/, "")}${PUSH_REGISTRATIONS_PATH}`;

/**
 * Sends one proof-carrying request to the registrations endpoint. The
 * payload object is stringified ONCE and that exact string is both hashed
 * into the proof's `payload` tag and sent as the request body.
 */
const sendRegistrationRequest = (args: {
  readonly serviceUrl: string;
  readonly method: "POST" | "DELETE";
  readonly payload: Record<string, string>;
  readonly secretKey: Uint8Array;
}): Effect.Effect<
  unknown,
  PushRegistrationError | RandomnessError,
  HttpClient.HttpClient | Randomness
> =>
  Effect.gen(function* () {
    const url = registrationsUrl(args.serviceUrl);
    const body = JSON.stringify(args.payload); // exact bytes the proof hashes

    const nowMs = yield* Clock.currentTimeMillis;
    const authorization = yield* buildNip98Token({
      url,
      method: args.method,
      payload: args.payload,
      secretKey: args.secretKey,
      nowSec: Math.floor(nowMs / 1000),
    });

    const http = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.make(args.method)(url).pipe(
      HttpClientRequest.setHeaders({
        Authorization: authorization,
        "Content-Type": "application/json",
      }),
      HttpClientRequest.bodyText(body, "application/json"),
    );

    const response = yield* http.execute(request).pipe(
      Effect.mapError(
        (error) =>
          new PushRegistrationError({
            url,
            status: null,
            code: null,
            reason: String(error.reason),
          }),
      ),
    );

    const json: unknown = yield* response.json.pipe(
      Effect.catchAll(() => Effect.succeed<unknown>(null)),
    );

    if (response.status < 200 || response.status >= 300) {
      const record = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
      return yield* Effect.fail(
        new PushRegistrationError({
          url,
          status: response.status,
          code: typeof record["error"] === "string" ? record["error"] : null,
          reason:
            typeof record["message"] === "string"
              ? record["message"]
              : `HTTP ${String(response.status)}`,
        }),
      );
    }

    return json;
  }).pipe(Effect.scoped);

/**
 * `POST /registrations` — registers one identity on this install. The
 * service replaces stale registrations (notifications.replace-stale): the
 * same identity+install updates its token in place, and any other install
 * still holding the same device token is removed.
 */
export const registerPushInstall = (
  args: RegisterPushInstallArgs,
): Effect.Effect<
  RegisterPushInstallResult,
  PushRegistrationError | RandomnessError,
  HttpClient.HttpClient | Randomness
> =>
  sendRegistrationRequest({
    serviceUrl: args.serviceUrl,
    method: "POST",
    payload: {
      recipientPubkey: args.recipientPubkeyHex,
      installationId: args.installationId,
      expoPushToken: args.expoPushToken,
    },
    secretKey: args.secretKey,
  }).pipe(
    Effect.map((json) => {
      const record = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
      const replaced = record["replacedStaleInstalls"];
      return { replacedStaleInstalls: typeof replaced === "number" ? replaced : 0 };
    }),
  );

/**
 * `DELETE /registrations` — removes one identity from this install; the
 * install disappears entirely with its last identity.
 */
export const unregisterPushInstall = (
  args: PushInstallIdentity,
): Effect.Effect<
  UnregisterPushInstallResult,
  PushRegistrationError | RandomnessError,
  HttpClient.HttpClient | Randomness
> =>
  sendRegistrationRequest({
    serviceUrl: args.serviceUrl,
    method: "DELETE",
    payload: {
      recipientPubkey: args.recipientPubkeyHex,
      installationId: args.installationId,
    },
    secretKey: args.secretKey,
  }).pipe(
    Effect.map((json) => {
      const record = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
      return {
        removedIdentity: record["removedIdentity"] === true,
        installRemoved: record["installRemoved"] === true,
      };
    }),
  );
