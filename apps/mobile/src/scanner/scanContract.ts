/**
 * Scanner result contract (#47, parsing/routing wired by #48).
 *
 * The scanner surface (`app/scanner.tsx`) is a pure INPUT surface: camera,
 * paste, gallery, and manual entry all funnel into one `ScanCapture` — a raw
 * string plus where it came from. Open it with an entry point:
 *
 *     router.push({ pathname: "/scanner", params: { entry: "contacts" } });
 *
 * `entry` ∈ `SCAN_ENTRY_POINTS` (missing/unknown → `"scan"`, the generic
 * surface). Per docs/feature-map/scanner-input.md the entry point decides
 * which scan types are accepted (`scanner.route-result`); the parse and
 * routing rules live in scanRouting.ts (pure) + scanResultHandler.ts
 * (impure). The handler returns how the capture was handled:
 *
 * - `{ kind: "handled" }`      — the handler routed the value itself
 *   (navigated with `context.router`; the handler dismisses the scanner,
 *   via `router.replace`/`router.dismissAll`).
 * - `{ kind: "unsupported", message }` — visible failure: the scanner
 *   stays open, shows `message` inline, and keeps scanning so the user
 *   can retry with a different code (feature-map contract: "Unsupported
 *   scans fail visibly").
 *
 * The handler may be async (the unknown-LNURL probe hits the network); the
 * scanner pauses capture delivery while a capture is in flight.
 */
import type { Translator } from "@linky/locales";
import type { ImperativeRouter } from "expo-router";

/** Entry points that open the scanner; mirror the PoC scan entry points. */
export const SCAN_ENTRY_POINTS = ["scan", "contacts", "send", "receive"] as const;
export type ScanEntryPoint = (typeof SCAN_ENTRY_POINTS)[number];

/** Which input surface produced the value (`scanner.camera/paste/gallery/manual`). */
export type ScanSource = "camera" | "paste" | "gallery" | "manual";

/** One raw captured value. `value` is trimmed and never empty. */
export interface ScanCapture {
  readonly value: string;
  readonly source: ScanSource;
  readonly entry: ScanEntryPoint;
}

/** Imperative tools the handler gets: navigation + translated copy. */
export interface ScanHandlerContext {
  readonly router: ImperativeRouter;
  readonly t: Translator;
}

export type ScanHandling =
  | { readonly kind: "handled" }
  | { readonly kind: "unsupported"; readonly message: string };

export type ScanCaptureHandler = (
  capture: ScanCapture,
  context: ScanHandlerContext,
) => Promise<ScanHandling>;
