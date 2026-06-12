/**
 * NFC tag payloads (#50, `profile.share-nfc` / `cashu.write-nfc`) — pure,
 * vitest-covered.
 *
 * Both writes put ONE well-known URI NDEF record on the tag; these builders
 * produce the URI text. The forms are the canonical link-arrival forms of
 * #48/#49, so a tag tap on any phone with Linky routes through the SAME
 * parse path as a scan, and a phone without Linky still does something
 * sensible:
 *
 * - Profile tag: `nostr://<npub>` (PoC `writeCurrentNpubToNfc` parity).
 *   Linky claims the `nostr` scheme (#49); other Nostr clients accept it
 *   too. The #48 classifier resolves it to the contact flow (tap-to-add).
 * - Token tag: `https://linky.fit/cashu/#<token>` (core
 *   `buildCashuShareUrl`). DIVERGES from the PoC on purpose — the PoC wrote
 *   `cashu://<token>`, which is a dead tap on phones without a Cashu app;
 *   the universal-link form opens Linky directly where installed and falls
 *   back to the linky.fit web page elsewhere, with the token in the URL
 *   FRAGMENT so it never reaches a server (cashu.md contract).
 */
import { buildCashuShareUrl, isValidNpub, normalizeNpubIdentifier } from "@linky/core";
import { Effect, Either } from "effect";

/** `nostr://<npub>` for the profile tag; `null` when the npub is invalid. */
export const buildProfileTagUrl = (npub: string): string | null => {
  const normalized = normalizeNpubIdentifier(npub);
  if (normalized === null || !isValidNpub(normalized)) return null;
  return `nostr://${normalized}`;
};

/** linky.fit share URL for the token tag; `null` for undecodable tokens. */
export const buildTokenTagUrl = (token: string): string | null => {
  const result = Effect.runSync(Effect.either(buildCashuShareUrl(token)));
  return Either.isRight(result) ? result.right : null;
};
