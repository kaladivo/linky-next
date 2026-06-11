/**
 * TEMPORARY dev-only scaffolding (issue #8).
 *
 * Exercises the real @linky/platform Layers end-to-end on a device/simulator:
 * SecureStorage (Keychain), KeyValueStorage (AsyncStorage), Clipboard,
 * Randomness (CSPRNG) and HttpClient (fetch). Surfaced by the
 * PlatformSmokeTestPanel on the Settings screen in non-production builds.
 *
 * Delete this module once real features cover these ports.
 */
import { Clipboard, HttpClient, KeyValueStorage, Randomness, SecureStorage } from "@linky/core";
import {
  ClipboardLive,
  HttpClientLive,
  KeyValueStorageLive,
  RandomnessLive,
  SecureStorageLive,
} from "@linky/platform";
import { Effect, Encoding, Layer, Option } from "effect";

import { environment } from "../environment";

export interface SmokeTestResult {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

const SmokeLayers = Layer.mergeAll(
  SecureStorageLive,
  KeyValueStorageLive,
  RandomnessLive,
  ClipboardLive,
  HttpClientLive,
);

const fail = (detail: string) => Effect.fail(new Error(detail));

const secureStorageCheck = Effect.gen(function* () {
  const storage = yield* SecureStorage;
  const key = "dev.smokeTest";
  const value = `secure-${Date.now()}`;
  yield* storage.set(key, value);
  const read = yield* storage.get(key);
  yield* storage.delete(key);
  const afterDelete = yield* storage.get(key);
  if (!Option.contains(read, value)) return yield* fail(`read back ${JSON.stringify(read)}`);
  if (Option.isSome(afterDelete)) return yield* fail("value survived delete");
  return "write → read → delete OK";
});

const keyValueCheck = Effect.gen(function* () {
  const kv = yield* KeyValueStorage.KeyValueStore;
  const key = "dev.smokeTest";
  const value = `kv-${Date.now()}`;
  yield* kv.set(key, value);
  const read = yield* kv.get(key);
  yield* kv.remove(key);
  if (!Option.contains(read, value)) return yield* fail(`read back ${JSON.stringify(read)}`);
  return "write → read → remove OK";
});

const clipboardCheck = Effect.gen(function* () {
  const clipboard = yield* Clipboard;
  const value = `clipboard-${Date.now()}`;
  yield* clipboard.copy(value);
  const read = yield* clipboard.read;
  if (!Option.contains(read, value)) return yield* fail(`read back ${JSON.stringify(read)}`);
  return "copy → read OK";
});

const randomnessCheck = Effect.gen(function* () {
  const randomness = yield* Randomness;
  const bytes = yield* randomness.nextBytes(16);
  if (bytes.length !== 16) return yield* fail(`expected 16 bytes, got ${bytes.length}`);
  if (bytes.every((byte) => byte === 0)) return yield* fail("all-zero bytes");
  return `16 bytes: ${Encoding.encodeHex(bytes)}`;
});

// Any HTTP response (even a 5xx from a flaky test mint) proves the fetch
// transport works end-to-end; only transport-level failures are a FAIL.
const httpCheck = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const url = `${environment.cashuMintUrl}/v1/info`;
  const response = yield* http.get(url);
  return `GET ${url} → ${response.status}`;
}).pipe(Effect.scoped);

const check = <E, R>(
  name: string,
  program: Effect.Effect<string, E, R>,
): Effect.Effect<SmokeTestResult, never, R> =>
  program.pipe(
    Effect.timeout("10 seconds"),
    Effect.map((detail) => ({ name, pass: true, detail })),
    Effect.catchAll((error) => Effect.succeed({ name, pass: false, detail: String(error) })),
  );

const allChecks = Effect.all(
  [
    check("SecureStorage", secureStorageCheck),
    check("KeyValueStorage", keyValueCheck),
    check("Clipboard", clipboardCheck),
    check("Randomness", randomnessCheck),
    check("HttpClient", httpCheck),
  ],
  { concurrency: 1 },
);

/** Runs all checks through the real platform Layers. Never rejects. */
export const runPlatformSmokeTests = (): Promise<readonly SmokeTestResult[]> =>
  Effect.runPromise(allChecks.pipe(Effect.provide(SmokeLayers)));
