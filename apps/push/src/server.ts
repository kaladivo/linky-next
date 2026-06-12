/**
 * node:http adapter around `handleRequest` — collects the raw body (the
 * NIP-98 payload hash is over the exact received bytes), extracts the
 * client IP, runs the request Effect on the ambient runtime, writes JSON.
 *
 * Scoped: the listener closes with the scope. `port: 0` gives an ephemeral
 * port (integration tests).
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { Effect, Runtime } from "effect";

import type { PushConfig } from "./config.js";
import type { WatcherStatusProvider } from "./http.js";
import { handleRequest } from "./http.js";
import type { RateLimiter } from "./rateLimit.js";
import type { PushStorage } from "./storage.js";
import type { Scope } from "effect";

const MAX_BODY_BYTES = 64 * 1024;

const clientIp = (request: IncomingMessage): string => {
  const forwarded = request.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  if (first !== undefined && first !== "") return first;
  return request.socket.remoteAddress ?? "unknown";
};

const collectBody = (request: IncomingMessage): Promise<string | null> =>
  new Promise((resolve) => {
    const chunks: Array<Buffer> = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop buffering but keep draining so the 413 response can still be
        // written on this connection (destroying the socket would kill it).
        request.removeAllListeners("data");
        request.removeAllListeners("end");
        request.resume();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(null));
  });

export interface RunningServer {
  readonly port: number;
  readonly server: Server;
}

export const serveHttp = (options: {
  readonly port: number;
  readonly watcherStatus?: WatcherStatusProvider;
}): Effect.Effect<RunningServer, Error, Scope.Scope | PushConfig | PushStorage | RateLimiter> =>
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime<PushConfig | PushStorage | RateLimiter>();
    const runPromise = Runtime.runPromise(runtime);

    const server = createServer((request, response) => {
      void (async () => {
        const rawBody = await collectBody(request);
        if (rawBody === null) {
          response.writeHead(413, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "payload_too_large", message: "Body too large" }));
          return;
        }
        const url = new URL(request.url ?? "/", "http://localhost");
        const result = await runPromise(
          handleRequest(
            {
              method: request.method ?? "GET",
              path: url.pathname,
              authorization: request.headers.authorization,
              rawBody,
              ip: clientIp(request),
            },
            options.watcherStatus,
          ),
        ).catch(() => ({
          status: 500,
          body: { error: "internal_error", message: "Internal server error" },
        }));
        response.writeHead(result.status, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(result.body));
      })();
    });

    yield* Effect.acquireRelease(
      Effect.async<void, Error>((resume) => {
        server.once("error", (error) => resume(Effect.fail(error)));
        server.listen(options.port, () => resume(Effect.void));
      }),
      () =>
        Effect.async<void>((resume) => {
          server.close(() => resume(Effect.void));
          // Pending keep-alive sockets would otherwise delay close.
          server.closeAllConnections();
        }),
    );

    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : options.port;
    return { port, server };
  });
