/**
 * Placeholder scan-capture handler (#47).
 *
 * TODO(#48): replace this body with the real parse/route pipeline
 * (`scanner.parse-nostr`, `scanner.parse-cashu`, `scanner.parse-lightning`,
 * `scanner.route-result`). The full contract — outcomes, entry-point
 * semantics, who dismisses the scanner — is documented in scanContract.ts.
 *
 * Until then every capture resolves to `"preview"`: the scanner screen
 * shows the raw captured string with a "handling lands in #48" note so the
 * surface is verifiable end-to-end without pretending to route anything.
 */
import type { ScanCaptureHandler } from "./scanContract";

export const handleScanCapture: ScanCaptureHandler = () =>
  Promise.resolve({ kind: "preview" });
