/**
 * Scanner result contract (#47 → #48).
 *
 * The scanner surface (`app/scanner.tsx`) is a pure INPUT surface: camera,
 * paste, gallery, and manual entry all funnel into one `ScanCapture` — a raw
 * string plus where it came from. Parsing and routing of that string
 * (npub → contact, BOLT11 → pay, Cashu → import, …) is issue #48's job.
 *
 * ## How #48 wires in
 *
 * 1. Open the scanner with an entry point:
 *
 *        router.push({ pathname: "/scanner", params: { entry: "contacts" } });
 *
 *    `entry` ∈ `SCAN_ENTRY_POINTS` (missing/unknown → `"scan"`, the generic
 *    surface). Per docs/feature-map/scanner-input.md the entry point decides
 *    which scan types are accepted (`scanner.route-result`).
 *
 * 2. Replace the placeholder in `scanResultHandler.ts` with the real
 *    parser/router. The handler receives every capture (camera, paste,
 *    gallery, manual — one parse path for every input source) and an
 *    imperative context, and returns how the capture was handled:
 *
 *    - `{ kind: "handled" }`      — the handler routed the value itself
 *      (navigate with `context.router`; it is the handler's job to dismiss
 *      the scanner, e.g. `router.back()` + push, or `router.replace`).
 *    - `{ kind: "unsupported", message }` — visible failure: the scanner
 *      stays open, shows `message` inline, and keeps scanning so the user
 *      can retry with a different code (feature-map contract: "Unsupported
 *      scans fail visibly").
 *    - `{ kind: "preview" }`      — placeholder outcome (#47 only): the
 *      scanner displays the captured string with a "handling lands in #48"
 *      note. #48 should stop returning this.
 *
 * The handler may be async (parsing may need network, e.g. LNURL probes);
 * the scanner pauses capture delivery while a capture is in flight.
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
  | { readonly kind: "unsupported"; readonly message: string }
  | { readonly kind: "preview" };

export type ScanCaptureHandler = (
  capture: ScanCapture,
  context: ScanHandlerContext,
) => Promise<ScanHandling>;
