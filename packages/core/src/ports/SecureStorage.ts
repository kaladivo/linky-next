/**
 * SecureStorage port — string secrets at rest (mnemonics, derived keys,
 * Cashu seeds). Implementations live in `packages/platform` (e.g. backed by
 * `expo-secure-store` / Keychain / Keystore); core only depends on this tag.
 *
 * Values are opaque strings. Anything structured (bytes, JSON) is encoded by
 * the caller before it crosses this port.
 */
import { Context, Data } from "effect";
import type { Effect, Option } from "effect";

/** Which operation failed — carried on every {@link SecureStorageError}. */
export type SecureStorageOperation = "get" | "set" | "delete";

/**
 * Expected failure of the secure store (keychain locked, entitlement missing,
 * corrupted entry, ...). Platform implementations must map their native
 * exceptions into this error; nothing is ever thrown across the port.
 */
export class SecureStorageError extends Data.TaggedError("SecureStorageError")<{
  readonly operation: SecureStorageOperation;
  readonly key: string;
  readonly cause?: unknown;
}> {}

export interface SecureStorageService {
  /** Read a secret. Absence is a value (`Option.none`), not an error. */
  readonly get: (key: string) => Effect.Effect<Option.Option<string>, SecureStorageError>;
  /** Create or overwrite a secret. */
  readonly set: (key: string, value: string) => Effect.Effect<void, SecureStorageError>;
  /** Remove a secret. Deleting a missing key succeeds (idempotent). */
  readonly delete: (key: string) => Effect.Effect<void, SecureStorageError>;
}

export class SecureStorage extends Context.Tag("@linky/core/SecureStorage")<
  SecureStorage,
  SecureStorageService
>() {}
