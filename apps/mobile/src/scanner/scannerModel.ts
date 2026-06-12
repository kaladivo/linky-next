/**
 * Pure helpers for the scanner surface (#47) — kept out of the screen so
 * they are unit-testable without React/Expo.
 */
import { SCAN_ENTRY_POINTS } from "./scanContract";
import type { ScanEntryPoint } from "./scanContract";

/**
 * Entry-point route param → ScanEntryPoint. Expo Router params arrive as
 * `string | string[] | undefined`; anything unknown falls back to the
 * generic "scan" surface so a bad deep link never crashes the screen.
 */
export const parseScanEntryPoint = (raw: string | string[] | undefined): ScanEntryPoint => {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (SCAN_ENTRY_POINTS as readonly string[]).includes(value ?? "")
    ? (value as ScanEntryPoint)
    : "scan";
};

/**
 * Screen title per entry point (PoC ScanModal title mapping). The return
 * type stays a narrow union of parameterless keys so `t(scannerTitleKey(e))`
 * typechecks (keys with placeholders would demand interpolation values).
 */
export type ScannerTitleKey = "scan" | "contactsScanContactQr" | "walletReceive" | "walletSend";

export const scannerTitleKey = (entry: ScanEntryPoint): ScannerTitleKey => {
  switch (entry) {
    case "contacts":
      return "contactsScanContactQr";
    case "receive":
      return "walletReceive";
    case "send":
      return "walletSend";
    case "scan":
      return "scan";
  }
};

/**
 * Normalize a raw captured/pasted/typed string. The contract promises
 * handlers a trimmed, non-empty `value`; empty input yields `null` so the
 * surface can show its "nothing captured" copy instead of calling the
 * handler.
 */
export const normalizeCapturedValue = (raw: string): string | null => {
  const value = raw.trim();
  return value === "" ? null : value;
};
