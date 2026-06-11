/**
 * Factory binding the Linky schema to an Evolu instance.
 *
 * Platform deps come from the caller: `@evolu/react-native/expo-sqlite`
 * (`evoluReactNativeDeps`) in the app, a Node better-sqlite3 assembly in
 * integration tests. This keeps the schema and queries platform-agnostic.
 */
import { createEvolu } from "@evolu/common";
import type { EvoluConfig, EvoluDeps } from "@evolu/common";
import { linkySchema } from "./schema";

export const createLinkyEvolu = (deps: EvoluDeps, config?: EvoluConfig) =>
  createEvolu(deps)(linkySchema, config);

export type LinkyEvolu = ReturnType<typeof createLinkyEvolu>;
