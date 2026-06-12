/**
 * Lazy react-native-nfc-manager loader (#50) — the ONLY place the NFC
 * library is required.
 *
 * Why lazy: the package registers a TurboModule via
 * `TurboModuleRegistry.getEnforcing`, which THROWS at import time when the
 * native module is absent (simulator dev client built before the #50
 * config-plugin change, or any future build without NFC). A static import
 * would crash the whole app on such builds; the lazy require turns that
 * into a cached `null`, and every entry point gates on it (the app must
 * work identically with NFC absent — feature-map contract).
 *
 * Note: on a CURRENT dev client the module is present even on simulators
 * (CoreNFC compiles there); `NfcManager.isSupported()` then reports false.
 * Support gating lives in ./nfcSupport.ts on top of this loader.
 */
import { Platform } from "react-native";
import type * as NfcLib from "react-native-nfc-manager";

export interface NfcModule {
  readonly manager: typeof NfcLib.default;
  readonly NfcTech: typeof NfcLib.NfcTech;
  readonly Ndef: typeof NfcLib.Ndef;
  readonly NfcError: typeof NfcLib.NfcError;
}

/** `undefined` = not attempted yet; `null` = load failed (no native NFC). */
let cached: NfcModule | null | undefined;

export const getNfcModule = (): NfcModule | null => {
  if (cached !== undefined) return cached;
  if (Platform.OS !== "ios" && Platform.OS !== "android") {
    cached = null;
    return cached;
  }
  try {
    // Lazy native-module load (see module doc) — a static import would
    // crash builds without the native module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const lib = require("react-native-nfc-manager") as typeof NfcLib;
    cached = {
      manager: lib.default,
      NfcTech: lib.NfcTech,
      Ndef: lib.Ndef,
      NfcError: lib.NfcError,
    };
  } catch {
    cached = null;
  }
  return cached;
};
