/**
 * Onboarding workflows (#17) — the Effect values the onboarding screens run
 * through `useEffectMutation`. App-level workflow module (like
 * src/locales/localePreference.ts): no React, no Expo, just composition of
 * core workflows; screens never import `effect` themselves.
 */
import type {
  ClipboardError,
  InvalidBackupPhraseError,
  RandomnessError,
  SecureStorageError,
} from "@linky/core";
import { Clipboard, createIdentitySession, restoreIdentitySession } from "@linky/core";
import { Effect, Option } from "effect";

import type { AppServices } from "../runtime";
import { invalidateSession } from "../session/sessionStore";

/**
 * `onboarding.create-account`: creates + persists a fresh master identity
 * (core `createIdentitySession`) and invalidates the session version so
 * every mounted `useSession` sees `IdentityLoaded`.
 *
 * Deliberately `void`: the resolved session is secret material and must
 * never sit in React state — downstream screens read what they need
 * (npub, backup phrase) through `useSession`.
 */
export const createAccount: Effect.Effect<
  void,
  RandomnessError | SecureStorageError,
  AppServices
> = createIdentitySession.pipe(
  Effect.tap(() => Effect.sync(invalidateSession)),
  Effect.asVoid,
);

/**
 * `onboarding.restore-account` / `identity.restore` (#18): restores +
 * persists the master identity from raw backup-word input (core
 * `restoreIdentitySession` — forgiving normalization, typed
 * InvalidBackupPhraseError) and invalidates the session version so the
 * #14/#16 gate lets the user in.
 *
 * Synced-domain reconnect (#15): nothing to wire here — Evolu owner lanes
 * derive deterministically from the restored master identity
 * (core `deriveOwnerLane`), so the SAME lane owners reattach whenever the
 * store boots from the session. There is no production store boot yet (only
 * the dev spike route creates an Evolu instance); #25/#35 boot the
 * session-scoped store with these lane mnemonics and complete the
 * reconnect.
 *
 * `void` like createAccount: the session is secret material and must never
 * sit in React state. The error keeps its word-level detail for the SCREEN
 * (inline display only) — it must never reach a logger.
 */
export const restoreAccount = (
  input: string,
): Effect.Effect<void, InvalidBackupPhraseError | SecureStorageError, AppServices> =>
  restoreIdentitySession(input).pipe(
    Effect.tap(() => Effect.sync(invalidateSession)),
    Effect.asVoid,
  );

/**
 * Reads the clipboard for the restore screen's paste button. An empty (or
 * non-text) clipboard resolves to `null` — the screen just does nothing.
 */
export const readClipboardText: Effect.Effect<string | null, ClipboardError, AppServices> =
  Effect.gen(function* () {
    const clipboard = yield* Clipboard;
    const text = yield* clipboard.read;
    return Option.getOrNull(text);
  });

/** Copies text via the Clipboard port (backup words are an EXPLICIT copy action). */
export const copyTextToClipboard = (
  text: string,
): Effect.Effect<void, ClipboardError, AppServices> =>
  Effect.gen(function* () {
    const clipboard = yield* Clipboard;
    yield* clipboard.copy(text);
  });
