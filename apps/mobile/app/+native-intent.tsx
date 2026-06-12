/**
 * Expo Router native-intent hook (#49, `scanner.links`): every URL the OS
 * delivers — cold start (`initial: true`) AND warm arrival — passes through
 * `redirectSystemPath` BEFORE routing. The pure transform lives in
 * src/scanner/deepLinkRouting.ts (vitest-covered); this file is just the
 * binding.
 *
 * KNOWN GOTCHA (see app/dev/restore.tsx): expo-dev-launcher swallows
 * external custom-scheme URLs (`cashu:`, `nostr:`, …) in development
 * builds — they never reach this hook. Use /dev/link-lab to exercise the
 * same transform + landing screen in the dev client; release builds get the
 * real OS delivery.
 */
import { redirectIncomingPath } from "../src/scanner/deepLinkRouting";

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return redirectIncomingPath(path);
}
