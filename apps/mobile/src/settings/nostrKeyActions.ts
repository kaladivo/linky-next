/**
 * Imperative actions behind the "Nostr keys" card on Advanced settings
 * (#20, `identity.use-custom-nostr-key` / `advanced.nostr-keys`).
 *
 * Each action runs the core workflow on the app runtime and invalidates the
 * session version, so every mounted `useSession` re-resolves the active
 * identity. Expected failures are mapped to plain result values here — the
 * card renders feedback, it never sees Effect errors. Values passing
 * through (nsec input, copied text) are secrets: never log them.
 */
import { Clipboard, activateCustomNostrKey, revertToDerivedNostrKey } from "@linky/core";
import { Effect, Option } from "effect";

import {
  reconcileNotificationRegistration,
  unregisterBeforeIdentitySwitch,
} from "../notifications/notificationActions";
import { runAppEffect } from "../runtime";
import { invalidateSession } from "../session/sessionStore";

export type ActivateCustomKeyResult = "activated" | "invalid" | "failed";

/**
 * Push registrations (#52, notifications.replace-stale) around a key
 * switch: the OLD identity unregisters BEFORE the switch — the only moment
 * its secret can still sign the unregister proof — and the NEW identity
 * registers right after, so a key change never leaves a broken or
 * duplicate registration behind. Both halves are best-effort.
 */
const reregisterAfterSwitch = (): void => {
  void reconcileNotificationRegistration().catch(() => undefined);
};

/** Validates + activates a pasted nsec override. */
export const activateCustomKey = async (input: string): Promise<ActivateCustomKeyResult> => {
  await unregisterBeforeIdentitySwitch();
  const result = await runAppEffect(
    activateCustomNostrKey(input).pipe(
      Effect.as("activated" as const),
      Effect.catchTag("InvalidNsecError", () => Effect.succeed("invalid" as const)),
      Effect.catchTag("SecureStorageError", () => Effect.succeed("failed" as const)),
    ),
  );
  if (result === "activated") invalidateSession();
  // Runs on failure too: an invalid nsec must re-register the unchanged
  // identity that was unregistered above.
  reregisterAfterSwitch();
  return result;
};

/** Reverts to the derived default key. Returns false on storage failure. */
export const revertToDerivedKey = async (): Promise<boolean> => {
  await unregisterBeforeIdentitySwitch();
  const ok = await runAppEffect(
    revertToDerivedNostrKey.pipe(
      Effect.as(true),
      Effect.catchTag("SecureStorageError", () => Effect.succeed(false)),
    ),
  );
  if (ok) invalidateSession();
  reregisterAfterSwitch();
  return ok;
};

/** Copies `text` via the Clipboard port. Returns false on failure. */
export const copyToClipboard = (text: string): Promise<boolean> =>
  runAppEffect(
    Effect.gen(function* () {
      const clipboard = yield* Clipboard;
      yield* clipboard.copy(text);
      return true;
    }).pipe(Effect.catchTag("ClipboardError", () => Effect.succeed(false))),
  );

/** Reads the clipboard text (the PoC's Paste reads the clipboard too). Empty → null. */
export const readClipboardText = (): Promise<string | null> =>
  runAppEffect(
    Effect.gen(function* () {
      const clipboard = yield* Clipboard;
      const text = yield* clipboard.read;
      return Option.getOrNull(text);
    }).pipe(Effect.catchTag("ClipboardError", () => Effect.succeed(null))),
  );
