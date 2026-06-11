/**
 * Node EvoluDeps assembly for integration tests.
 *
 * Mirrors what `@evolu/react-native/expo-sqlite` does for the app
 * (`createSharedEvoluDeps`), but with the better-sqlite3 driver from
 * `@evolu/nodejs` so Evolu runs against real local SQLite inside vitest.
 */
import {
  createConsole,
  createRandom,
  createRandomBytes,
  createTime,
  createWebSocket,
} from "@evolu/common";
import type { EvoluDeps } from "@evolu/common";
import { createDbWorkerForPlatform } from "@evolu/common/local-first";
import { createBetterSqliteDriver } from "@evolu/nodejs";

export const createNodeEvoluDeps = (): EvoluDeps => {
  const console = createConsole();
  const randomBytes = createRandomBytes();
  const time = createTime();

  return {
    console,
    createDbWorker: () =>
      createDbWorkerForPlatform({
        console,
        createSqliteDriver: createBetterSqliteDriver,
        createWebSocket,
        random: createRandom(),
        randomBytes,
        time,
      }),
    randomBytes,
    reloadApp: () => {
      // No-op in tests; Evolu calls this after resetAppOwner/restoreAppOwner.
    },
    time,
  };
};
