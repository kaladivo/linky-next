/**
 * NFC device-support gate (#50). Feature-map contract for every NFC
 * feature: "Availability depends on device support" — each entry point
 * (scanner read button, profile write, token write) renders ONLY when this
 * gate resolves true, and the app behaves identically with NFC absent.
 *
 * `false` covers every absence flavor at once: web/unknown platform, a dev
 * client built without the native module (lazy-load failure in
 * ./nfcModule.ts), and present-but-unsupported hardware (simulators, iPads
 * without NFC, Androids without the chip — `NfcManager.isSupported()`).
 * The probe result cannot change within a process, so it is cached.
 */
import { useEffect, useState } from "react";

import { getNfcModule } from "./nfcModule";

let supportPromise: Promise<boolean> | null = null;

const probeSupport = async (): Promise<boolean> => {
  const nfc = getNfcModule();
  if (nfc === null) return false;
  try {
    return (await nfc.manager.isSupported()) === true;
  } catch {
    return false;
  }
};

/** Resolves once per process; never rejects. */
export const isNfcSupported = (): Promise<boolean> => {
  supportPromise ??= probeSupport();
  return supportPromise;
};

/**
 * Render gate for NFC entry points: `false` until the (fast, local) probe
 * resolves — unsupported devices never see a flash of NFC UI.
 */
export const useNfcSupported = (): boolean => {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    let live = true;
    void isNfcSupported().then((value) => {
      if (live) setSupported(value);
    });
    return () => {
      live = false;
    };
  }, []);
  return supported;
};
