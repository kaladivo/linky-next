/**
 * Clipboard port — copying payment requests / tokens / invoices out of the
 * app and reading pasted ones back in. Implementations live in
 * `packages/platform` (backed by `expo-clipboard`).
 *
 * Values are plain strings; anything structured (Cashu token, LNURL, invoice)
 * is encoded/decoded by the caller. Secrets must never transit the clipboard
 * implicitly — copying secret material is always an explicit user action.
 */
import { Context, Data } from "effect";
import type { Effect, Option } from "effect";

/** Which operation failed — carried on every {@link ClipboardError}. */
export type ClipboardOperation = "copy" | "read";

/**
 * Expected failure of the platform clipboard (pasteboard unavailable, bridge
 * error, OS denied access). Platform implementations must map their native
 * exceptions into this error; nothing is ever thrown across the port.
 */
export class ClipboardError extends Data.TaggedError("ClipboardError")<{
  readonly operation: ClipboardOperation;
  readonly cause?: unknown;
}> {}

export interface ClipboardService {
  /** Replace the clipboard contents with `text`. */
  readonly copy: (text: string) => Effect.Effect<void, ClipboardError>;
  /**
   * Read the current clipboard text. An empty clipboard (or one holding
   * non-text content) is `Option.none()` — absence is a value, not an error.
   */
  readonly read: Effect.Effect<Option.Option<string>, ClipboardError>;
}

export class Clipboard extends Context.Tag("@linky/core/Clipboard")<
  Clipboard,
  ClipboardService
>() {}
