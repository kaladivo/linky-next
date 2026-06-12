/**
 * Unified scan parsing & routing decisions (#48) — pure, vitest-covered.
 *
 * `scanner.parse-nostr` / `scanner.parse-cashu` / `scanner.parse-lightning`:
 * one classifier for every input source (camera, paste, gallery, manual),
 * composing the core parsers in the PoC scanner's order
 * (`useScannedTextHandler`): Cashu token extraction first, then npub, then
 * the Lightning classification chain.
 *
 * `scanner.route-result`: `decideScanRoute` maps (target × entry point) to
 * a destination. Feature-map contracts enforced here:
 * - the receive entry NEVER initiates an outgoing payment;
 * - the contacts entry also rejects payment targets (issue #48 text; the
 *   PoC paid from its contacts scan — intentional divergence);
 * - Cashu tokens import and npubs go through the contact flow from EVERY
 *   entry (PoC parity: bearer tokens are banked wherever they show up).
 *
 * The impure half (storage, network probes, navigation) lives in
 * ./scanResultHandler.ts.
 */
import {
  extractCashuTokenFromText,
  isValidNpub,
  normalizeNpubIdentifier,
  parseLightningInput,
} from "@linky/core";
import { Effect, Either, Option } from "effect";

import type { ScanEntryPoint } from "./scanContract";

// ---------------------------------------------------------------------------
// Classification (parse-nostr / parse-cashu / parse-lightning)
// ---------------------------------------------------------------------------

export type ScanTarget =
  /** A decodable Cashu token (raw `cashuA…`/`cashuB…` or any wrapped link). */
  | { readonly kind: "cashu-token"; readonly token: string }
  /** A checksum-valid npub (bare, `nostr:` URI, or `<npub>@npub.cash`). */
  | { readonly kind: "npub"; readonly npub: string }
  | { readonly kind: "bolt11"; readonly invoice: string }
  /** Lightning address — kept as the address text for the pay screen. */
  | { readonly kind: "lightning-address"; readonly address: string }
  | { readonly kind: "lnurl-pay"; readonly url: string }
  | { readonly kind: "lnurl-withdraw"; readonly url: string }
  /** LNURL whose sub-protocol is unknown until the metadata fetch. */
  | { readonly kind: "lnurl-unknown"; readonly url: string }
  | { readonly kind: "unsupported" };

/** bech32 charset; used only for npubs embedded in `nostr:` deep links. */
const NPUB_IN_NOSTR_LINK = /npub1[02-9ac-hj-np-z]+/i;

/**
 * npub from scan text (`scanner.parse-nostr`): the #27 normalizer (bare
 * npub, `nostr:` URI, `<npub>@npub.cash`) plus the PoC's native deep-link
 * forms (`nostr://contact/npub1…`, `nostr://npub/npub1…`), where the npub
 * is extracted from the path. Treating npub.cash addresses as contact
 * identifiers (not pay targets) diverges from the PoC scanner on purpose —
 * it matches the #27 contact-form semantics.
 */
const npubFromScanText = (value: string): string | null => {
  const normalized = normalizeNpubIdentifier(value);
  if (normalized !== null && isValidNpub(normalized)) return normalized;

  if (/^nostr:/i.test(value)) {
    const match = NPUB_IN_NOSTR_LINK.exec(value);
    if (match !== null) {
      const candidate = match[0].toLowerCase();
      if (isValidNpub(candidate)) return candidate;
    }
  }
  return null;
};

/**
 * Classifies one captured string. PoC order: Cashu token extraction first
 * (tokens travel inside links and free text), then npub, then the
 * Lightning chain (explicit LNURL schemes → address → BOLT11 → bech32
 * LNURL / bare http URL).
 */
export const classifyScanValue = (raw: string): ScanTarget => {
  const value = raw.trim();
  if (value === "") return { kind: "unsupported" };

  const token = Option.getOrNull(extractCashuTokenFromText(value));
  if (token !== null) return { kind: "cashu-token", token };

  const npub = npubFromScanText(value);
  if (npub !== null) return { kind: "npub", npub };

  const lightning = Effect.runSync(Effect.either(parseLightningInput(value)));
  if (Either.isRight(lightning)) {
    switch (lightning.right._tag) {
      case "Bolt11Input":
        return { kind: "bolt11", invoice: lightning.right.invoice.invoice };
      case "LightningAddressInput":
        return { kind: "lightning-address", address: lightning.right.address.address };
      case "LnurlPayInput":
        return { kind: "lnurl-pay", url: lightning.right.url };
      case "LnurlWithdrawInput":
        return { kind: "lnurl-withdraw", url: lightning.right.url };
      case "LnurlInput":
        return { kind: "lnurl-unknown", url: lightning.right.url };
    }
  }

  return { kind: "unsupported" };
};

// ---------------------------------------------------------------------------
// Routing (route-result)
// ---------------------------------------------------------------------------

export type ScanDecision =
  /** Accept the token into the wallet (#38 `cashu.accept-token`). */
  | { readonly kind: "import-token"; readonly token: string }
  /** Own npub → profile; existing → that contact; new → create (#27). */
  | { readonly kind: "contact-flow"; readonly npub: string }
  | { readonly kind: "pay-invoice"; readonly invoice: string }
  /** /wallet/pay-address target (address text or LNURL-pay endpoint). */
  | { readonly kind: "pay-target"; readonly target: string }
  | { readonly kind: "withdraw"; readonly target: string }
  /** Unknown-tag LNURL: probe withdraw first, pay on tag mismatch (PoC). */
  | { readonly kind: "probe-lnurl"; readonly url: string }
  /** Entry point forbids payment targets — fail visibly. */
  | { readonly kind: "reject-payment" }
  | { readonly kind: "unsupported" };

/** Entries that must never initiate an outgoing payment. */
export const entryRejectsPayments = (entry: ScanEntryPoint): boolean =>
  entry === "receive" || entry === "contacts";

export const decideScanRoute = (target: ScanTarget, entry: ScanEntryPoint): ScanDecision => {
  switch (target.kind) {
    case "cashu-token":
      return { kind: "import-token", token: target.token };
    case "npub":
      return { kind: "contact-flow", npub: target.npub };
    case "bolt11":
      return entryRejectsPayments(entry)
        ? { kind: "reject-payment" }
        : { kind: "pay-invoice", invoice: target.invoice };
    case "lightning-address":
      return entryRejectsPayments(entry)
        ? { kind: "reject-payment" }
        : { kind: "pay-target", target: target.address };
    case "lnurl-pay":
      return entryRejectsPayments(entry)
        ? { kind: "reject-payment" }
        : { kind: "pay-target", target: target.url };
    case "lnurl-withdraw":
      // Withdraw is incoming money — allowed from every entry (PoC parity).
      return { kind: "withdraw", target: target.url };
    case "lnurl-unknown":
      // The probe resolves the tag; the entry gate re-applies to a pay tag.
      return { kind: "probe-lnurl", url: target.url };
    case "unsupported":
      return { kind: "unsupported" };
  }
};
