/**
 * NFC tag sessions (#50) — the impure half over ./nfcModule.ts:
 * one-tag-read (`scanner.nfc-read`) and one-URI-write
 * (`profile.share-nfc` / `cashu.write-nfc`) sessions, mapped to plain
 * outcome values (screens render outcomes, never library errors — the
 * tokenActions convention).
 *
 * Session shape (both platforms drive the same `requestTechnology(Ndef)`
 * flow): iOS shows the system NFC sheet (with its own cancel; `alertMessage`
 * is the sheet text), Android scans silently — the calling screen renders
 * the "hold a tag" prompt + cancel there. One session at a time; a second
 * request reports `busy` (PoC `nfcWriteBusy`).
 *
 * Outcome mapping: the user closing the sheet (UserCancel) and the iOS
 * 60s session timeout are both `cancelled` — silent non-events, never an
 * error toast. Everything else fails visibly with the library message.
 *
 * Write payload: ONE well-known URI NDEF record (library `Ndef.uriRecord`,
 * NFC Forum prefix compression — the read side's ndefValues.ts decodes it
 * back; payload text comes from ./nfcPayload.ts). The write resolving
 * WITHOUT throwing is the tag-write CONFIRMATION the token-externalization
 * flow orders on (see the token detail screen).
 */
import type { NfcModule } from "./nfcModule";
import { getNfcModule } from "./nfcModule";
import { firstNdefScanValue } from "./ndefValues";

export type NfcReadOutcome =
  | { readonly kind: "value"; readonly value: string }
  /** Tag reached but nothing decodable on it. */
  | { readonly kind: "empty" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "busy" }
  /** Android: hardware present but NFC turned off in system settings. */
  | { readonly kind: "disabled" }
  /** No NFC on this build/device — entry points are gated, so reaching this is a bug. */
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed"; readonly message: string | null };

export type NfcWriteOutcome =
  | { readonly kind: "written" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "busy" }
  | { readonly kind: "disabled" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "failed"; readonly message: string | null };

type NfcFailure = Exclude<NfcReadOutcome, { kind: "value" } | { kind: "empty" }>;

let started = false;
let sessionActive = false;

const ensureStarted = async (nfc: NfcModule): Promise<void> => {
  if (started) return;
  await nfc.manager.start();
  started = true;
};

const classifyError = (nfc: NfcModule, error: unknown): NfcFailure => {
  if (error instanceof nfc.NfcError.UserCancel) return { kind: "cancelled" };
  if (error instanceof nfc.NfcError.Timeout) return { kind: "cancelled" };
  if (error instanceof nfc.NfcError.SystemBusy) return { kind: "busy" };
  if (error instanceof nfc.NfcError.RadioDisabled) return { kind: "disabled" };
  if (error instanceof nfc.NfcError.UnsupportedFeature) return { kind: "unavailable" };
  const message = error instanceof Error ? error.message.trim() : String(error ?? "").trim();
  return { kind: "failed", message: message === "" ? null : message };
};

/**
 * Runs `operate` inside an exclusive NDEF technology session. The session
 * is ALWAYS released (cancelTechnologyRequest in finally — a leaked session
 * blocks every later one); release failures are ignored by design.
 */
const withNdefSession = async <A>(
  alertMessage: string,
  operate: (nfc: NfcModule) => Promise<A>,
): Promise<A | NfcFailure> => {
  const nfc = getNfcModule();
  if (nfc === null) return { kind: "unavailable" };
  if (sessionActive) return { kind: "busy" };
  sessionActive = true;
  try {
    await ensureStarted(nfc);
    // Android reports radio-off synchronously; surface it before the
    // (silent, sheet-less) session would just hang.
    try {
      if ((await nfc.manager.isEnabled()) !== true) return { kind: "disabled" };
    } catch {
      // iOS builds without the method / probe hiccups: proceed; a real
      // radio problem still surfaces from requestTechnology below.
    }
    await nfc.manager.requestTechnology(nfc.NfcTech.Ndef, { alertMessage });
    return await operate(nfc);
  } catch (error) {
    return classifyError(nfc, error);
  } finally {
    sessionActive = false;
    nfc.manager.cancelTechnologyRequest().catch(() => undefined);
  }
};

/** iOS-only success text on the system sheet; a no-op everywhere else. */
const showSuccessAlert = async (nfc: NfcModule, message: string): Promise<void> => {
  try {
    await nfc.manager.setAlertMessage(message);
  } catch {
    // cosmetic only
  }
};

/** One-shot tag read: decode the tag's first value-bearing NDEF record. */
export const readNfcTag = (messages: {
  readonly prompt: string;
  readonly success: string;
}): Promise<NfcReadOutcome> =>
  withNdefSession(messages.prompt, async (nfc): Promise<NfcReadOutcome> => {
    const tag = await nfc.manager.getTag();
    const value = firstNdefScanValue(tag?.ndefMessage);
    if (value === null) return { kind: "empty" };
    await showSuccessAlert(nfc, messages.success);
    return { kind: "value", value };
  });

/** One-shot URI write; resolving `written` confirms the tag holds the URI. */
export const writeNfcTagUri = (
  url: string,
  messages: { readonly prompt: string; readonly success: string },
): Promise<NfcWriteOutcome> =>
  withNdefSession(messages.prompt, async (nfc): Promise<NfcWriteOutcome> => {
    const bytes = nfc.Ndef.encodeMessage([nfc.Ndef.uriRecord(url)]);
    await nfc.manager.ndefHandler.writeNdefMessage(bytes);
    await showSuccessAlert(nfc, messages.success);
    return { kind: "written" };
  });

/**
 * Cancels the in-flight session (the Android prompt's cancel button; iOS
 * uses the system sheet's own cancel). The pending read/write resolves
 * `cancelled` through the error mapping.
 */
export const cancelNfcSession = (): void => {
  const nfc = getNfcModule();
  if (nfc === null) return;
  nfc.manager.cancelTechnologyRequest().catch(() => undefined);
};
