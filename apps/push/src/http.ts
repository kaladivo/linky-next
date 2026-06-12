/**
 * HTTP API — pure request → response Effects (no sockets here; `server.ts`
 * adapts node:http onto `handleRequest`, and tests can call it directly).
 *
 * Routes:
 *
 * - `GET  /health` — liveness + per-relay watcher state.
 * - `POST /registrations` — register ONE identity (recipient pubkey) on one
 *   install. NIP-98 proof required (see `proof.ts`). Replaces stale
 *   registrations instead of duplicating (notifications.replace-stale).
 * - `DELETE /registrations` — remove one identity from one install; the
 *   install disappears entirely when its last proven identity is removed.
 *
 * A multi-identity install registers/unregisters once per identity — proofs
 * are per identity by design (each one is signed by the identity it claims).
 *
 * Abuse limits (notifications.abuse-limits): per-IP fixed windows on both
 * endpoints, a per-pubkey attempt window on top, and hard caps on
 * registrations per identity / identities per install (storage-enforced).
 */
import { Clock, Data, Effect, Either, Schema } from "effect";

import { PushConfig } from "./config.js";
import { verifyRegistrationProof } from "./proof.js";
import { RateLimiter } from "./rateLimit.js";
import { PushStorage } from "./storage.js";

export interface HttpRequest {
  readonly method: string;
  readonly path: string;
  /** Raw `Authorization` header, when present. */
  readonly authorization: string | undefined;
  /** Raw body exactly as received (NIP-98 payload hash covers it). */
  readonly rawBody: string;
  /** Remote address (first `x-forwarded-for` hop or socket peer). */
  readonly ip: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export interface RelayWatchStatus {
  readonly live: boolean;
  readonly lastLiveEventAtMs: number | null;
}

/** Watcher state surfaced on /health; the server wires the real provider. */
export type WatcherStatusProvider = Effect.Effect<Readonly<Record<string, RelayWatchStatus>>>;

class RequestFailure extends Data.TaggedError("RequestFailure")<{
  readonly status: number;
  readonly code: string;
  readonly message: string;
}> {}

// ---------------------------------------------------------------------------
// Body schemas
// ---------------------------------------------------------------------------

const Hex64 = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/));
/** Client-generated install id; charset-bounded to keep storage clean. */
const InstallationId = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9._-]{1,128}$/));
/** Expo push token as registered by the mobile app (#52). */
const ExpoPushToken = Schema.String.pipe(Schema.pattern(/^Expo(nent)?PushToken\[[^\][]{1,256}\]$/));

const RegisterBody = Schema.Struct({
  recipientPubkey: Hex64,
  installationId: InstallationId,
  expoPushToken: ExpoPushToken,
});

const UnregisterBody = Schema.Struct({
  recipientPubkey: Hex64,
  installationId: InstallationId,
});

const decodeRegisterBody = Schema.decodeUnknownEither(RegisterBody);
const decodeUnregisterBody = Schema.decodeUnknownEither(UnregisterBody);

const parseBody = <A, E>(
  rawBody: string,
  decode: (input: unknown) => Either.Either<A, E>,
): Effect.Effect<A, RequestFailure> =>
  Effect.suspend(() => {
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return Effect.fail(
        new RequestFailure({
          status: 400,
          code: "invalid_json",
          message: "Request body must be valid JSON",
        }),
      );
    }
    const decoded = decode(json);
    if (Either.isLeft(decoded)) {
      return Effect.fail(
        new RequestFailure({
          status: 400,
          code: "invalid_request",
          message: "Request body failed validation",
        }),
      );
    }
    return Effect.succeed(decoded.right);
  });

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

const rateLimited = new RequestFailure({
  status: 429,
  code: "rate_limited",
  message: "Too many requests",
});

const checkLimit = (
  key: string,
  max: number,
  windowMs: number,
  nowMs: number,
): Effect.Effect<void, RequestFailure, RateLimiter> =>
  Effect.gen(function* () {
    const limiter = yield* RateLimiter;
    const allowed = yield* limiter.check(key, max, windowMs, nowMs);
    if (!allowed) return yield* Effect.fail(rateLimited);
  });

const checkProof = (
  request: HttpRequest,
  recipientPubkey: string,
  nowMs: number,
): Effect.Effect<void, RequestFailure, PushConfig | PushStorage> =>
  Effect.gen(function* () {
    const config = yield* PushConfig;
    yield* verifyRegistrationProof({
      authorization: request.authorization,
      expectedUrl: `${config.publicBaseUrl}${request.path}`,
      expectedMethod: request.method,
      rawBody: request.rawBody,
      expectedPubkey: recipientPubkey,
      nowMs,
      proofMaxAgeSec: config.proofMaxAgeSec,
    }).pipe(
      Effect.mapError(
        (error) =>
          new RequestFailure({
            status: 401,
            code: "invalid_proof",
            message: `Ownership proof rejected: ${error.reason}`,
          }),
      ),
    );
  });

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

type Deps = PushConfig | PushStorage | RateLimiter;

const register = (request: HttpRequest): Effect.Effect<HttpResponse, RequestFailure, Deps> =>
  Effect.gen(function* () {
    const config = yield* PushConfig;
    const nowMs = yield* Clock.currentTimeMillis;
    yield* checkLimit(
      `register:ip:${request.ip}`,
      config.registerRateLimitMax,
      config.registerRateLimitWindowMs,
      nowMs,
    );
    const body = yield* parseBody(request.rawBody, decodeRegisterBody);
    yield* checkLimit(
      `register:pk:${body.recipientPubkey}`,
      config.perPubkeyRateLimitMax,
      config.perPubkeyRateLimitWindowMs,
      nowMs,
    );
    yield* checkProof(request, body.recipientPubkey, nowMs);

    const storage = yield* PushStorage;
    const result = yield* storage.register({
      recipientPubkey: body.recipientPubkey,
      installationId: body.installationId,
      expoPushToken: body.expoPushToken,
      nowMs,
      maxInstallsPerIdentity: config.maxInstallsPerIdentity,
      maxIdentitiesPerInstall: config.maxIdentitiesPerInstall,
    });
    switch (result._tag) {
      case "limit-installs-per-identity":
        return yield* Effect.fail(
          new RequestFailure({
            status: 409,
            code: "registration_limit",
            message: "This identity is registered on too many installs",
          }),
        );
      case "limit-identities-per-install":
        return yield* Effect.fail(
          new RequestFailure({
            status: 409,
            code: "registration_limit",
            message: "This install has registered too many identities",
          }),
        );
      case "registered":
        return {
          status: 200,
          body: { ok: true, replacedStaleInstalls: result.replacedStaleInstalls },
        };
    }
  });

const unregister = (request: HttpRequest): Effect.Effect<HttpResponse, RequestFailure, Deps> =>
  Effect.gen(function* () {
    const config = yield* PushConfig;
    const nowMs = yield* Clock.currentTimeMillis;
    yield* checkLimit(
      `unregister:ip:${request.ip}`,
      config.registerRateLimitMax,
      config.registerRateLimitWindowMs,
      nowMs,
    );
    const body = yield* parseBody(request.rawBody, decodeUnregisterBody);
    yield* checkProof(request, body.recipientPubkey, nowMs);

    const storage = yield* PushStorage;
    const result = yield* storage.unregister({
      recipientPubkey: body.recipientPubkey,
      installationId: body.installationId,
    });
    return {
      status: 200,
      body: {
        ok: true,
        removedIdentity: result.removedIdentity,
        installRemoved: result.installRemoved,
      },
    };
  });

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export const handleRequest = (
  request: HttpRequest,
  watcherStatus: WatcherStatusProvider = Effect.succeed({}),
): Effect.Effect<HttpResponse, never, Deps> =>
  Effect.gen(function* () {
    if (request.method === "GET" && request.path === "/health") {
      const relays = yield* watcherStatus;
      return { status: 200, body: { ok: true, relays } };
    }
    if (request.path === "/registrations" && request.method === "POST") {
      return yield* register(request);
    }
    if (request.path === "/registrations" && request.method === "DELETE") {
      return yield* unregister(request);
    }
    return yield* Effect.fail(
      new RequestFailure({ status: 404, code: "not_found", message: "Route not found" }),
    );
  }).pipe(
    Effect.catchTag("RequestFailure", (failure) =>
      Effect.succeed({
        status: failure.status,
        body: { error: failure.code, message: failure.message },
      }),
    ),
    Effect.catchAllCause((cause) =>
      Effect.logError("unhandled request error", cause).pipe(
        Effect.as({
          status: 500,
          body: { error: "internal_error", message: "Internal server error" },
        }),
      ),
    ),
  );
