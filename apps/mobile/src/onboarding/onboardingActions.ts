/**
 * Onboarding workflows (#17) — the Effect values the onboarding screens run
 * through `useEffectMutation`. App-level workflow module (like
 * src/locales/localePreference.ts): no React, no Expo, just composition of
 * core workflows; screens never import `effect` themselves.
 */
import type { ClipboardError, RandomnessError, SecureStorageError } from "@linky/core";
import { Clipboard, createIdentitySession } from "@linky/core";
import { Effect } from "effect";

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

/** Copies text via the Clipboard port (backup words are an EXPLICIT copy action). */
export const copyTextToClipboard = (
  text: string,
): Effect.Effect<void, ClipboardError, AppServices> =>
  Effect.gen(function* () {
    const clipboard = yield* Clipboard;
    yield* clipboard.copy(text);
  });
