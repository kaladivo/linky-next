/**
 * Entrypoint — wires the production Layers and runs HTTP server, relay
 * watcher and the hourly prune loop until SIGINT/SIGTERM.
 *
 * The service holds NO decryption capability: its state is recipient
 * pubkeys, install ids, Expo push tokens and dedupe bookkeeping.
 */
import { Socket } from "@effect/platform";
import { layerNostrTransportSocket } from "@linky/core";
import { Clock, Effect, Fiber, Layer } from "effect";

import { layerConfig, loadConfig, PushConfig } from "./config.js";
import { layerExpoPushSender } from "./pushSender.js";
import { layerRateLimiter } from "./rateLimit.js";
import { serveHttp } from "./server.js";
import { layerSqliteStorage, PushStorage } from "./storage.js";
import { makeWatcher } from "./watcher.js";

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const pruneLoop = Effect.gen(function* () {
  const config = yield* PushConfig;
  const storage = yield* PushStorage;
  for (;;) {
    const nowMs = yield* Clock.currentTimeMillis;
    yield* storage.pruneSeenEvents(nowMs - config.seenEventRetentionMs);
    yield* storage.pruneProofs(nowMs);
    yield* Effect.sleep(PRUNE_INTERVAL_MS);
  }
});

const program = Effect.gen(function* () {
  const config = yield* PushConfig;
  const watcher = yield* makeWatcher;
  const { port } = yield* serveHttp({ port: config.port, watcherStatus: watcher.status });
  yield* Effect.logInfo(
    `push: listening port=${port} relays=${config.relayUrls.join(",")} db=${config.dbPath}`,
  );
  yield* Effect.forkScoped(watcher.run);
  yield* Effect.forkScoped(pruneLoop);
  yield* Effect.never;
});

const main = (): void => {
  const config = loadConfig(process.env);
  const layers = Layer.mergeAll(
    layerConfig(config),
    layerSqliteStorage(config.dbPath),
    layerRateLimiter,
    layerExpoPushSender({
      expoPushUrl: config.expoPushUrl,
      expoAccessToken: config.expoAccessToken,
    }),
    layerNostrTransportSocket().pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
  );

  const fiber = Effect.runFork(program.pipe(Effect.provide(layers), Effect.scoped));
  const shutdown = (): void => {
    Effect.runFork(Fiber.interrupt(fiber));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
};

main();
