/**
 * Golden tests for the mints domain (issue #41): URL canonicalization, NUT-06
 * info parsing, hosted-server resolution and the NIP-98 mint-sync token are
 * pinned against fixtures generated FROM THE POC'S OWN CODE/DEPS — see
 * `__fixtures__/README.md` (incl. the documented divergence table).
 */
import { readFileSync } from "node:fs";
import { Effect, Either, Encoding } from "effect";
import { describe, expect, it } from "vitest";

import { isTestMintUrl } from "../environment/EnvironmentConfig.js";
import type { NostrEvent } from "../nostr/NostrEvent.js";
import { verifyNostrEvent } from "../nostr/NostrEvent.js";
import { RandomnessFixed, hexToBytes } from "../nostr/nostrTestKit.js";
import { mintInfoIconUrl, parseMintInfoPayload } from "./mintInfo.js";
import { canonicalizeMintUrl, mintDisplayName, mintOriginAndHost } from "./mintUrl.js";
import { buildNip98Token, NIP98_AUTHORIZATION_SCHEME } from "./nip98.js";
import {
  DEFAULT_NPUB_CASH_SERVER_BASE_URL,
  resolveNpubCashServerBaseUrl,
} from "./npubCashServer.js";

interface MintsGolden {
  readonly normalizeMintUrl: ReadonlyArray<{ input: string; output: string }>;
  readonly getMintOriginAndHost: ReadonlyArray<{
    input: string;
    output: { origin: string | null; host: string | null };
  }>;
  readonly getMintSelectionDisplayName: ReadonlyArray<{ input: string; output: string }>;
  readonly isTestMintUrl: ReadonlyArray<{ input: string; output: boolean }>;
  readonly parseMintInfoPayload: ReadonlyArray<{
    name: string;
    payload: unknown;
    output: { feesJson: string | null; infoJson: string | null; supportsMpp: string | null };
  }>;
  readonly getMintInfoIconUrl: ReadonlyArray<{
    name: string;
    mintUrl: string;
    infoJson: string | null;
    output: string | null;
  }>;
  readonly resolveNpubCashServerBaseUrl: ReadonlyArray<{
    input: string | null;
    output: string;
  }>;
  readonly resolveMintSyncServerBaseUrl: ReadonlyArray<{ name: string; output: string }>;
  readonly nip98: {
    readonly privHex: string;
    readonly cases: ReadonlyArray<{
      name: string;
      baseUrl: string;
      inputMintUrl: string;
      nowSec: number;
      request: { url: string; method: string; contentType: string; body: string };
      authorizationScheme: string;
      eventJsonSigMasked: string;
      payloadHashHex: string;
    }>;
  };
}

const fixtures = JSON.parse(
  readFileSync(new URL("./__fixtures__/mints.golden.json", import.meta.url), "utf8"),
) as MintsGolden;

/** PoC outputs we intentionally do NOT reproduce (README divergence table). */
const NORMALIZE_DIVERGENCES: Readonly<Record<string, string>> = {
  // WHATWG `origin` leak for non-special schemes; we keep the input as-is.
  "foo://bar/baz": "foo://bar/baz",
};

/** Deliberate superset: nofees testnut + localhost are test mints here. */
const TEST_MINT_DIVERGENCES: ReadonlySet<string> = new Set([
  "https://nofees.testnut.cashu.space",
  "http://localhost:3338",
]);

describe("mints.golden — canonicalizeMintUrl (PoC normalizeMintUrl)", () => {
  for (const { input, output } of fixtures.normalizeMintUrl) {
    const divergence = NORMALIZE_DIVERGENCES[input];
    if (divergence !== undefined) {
      it(`DIVERGES on ${JSON.stringify(input)} (PoC: ${JSON.stringify(output)})`, () => {
        expect(output).not.toBe(divergence); // fixture really pins the PoC bug
        expect(canonicalizeMintUrl(input)).toBe(divergence);
      });
      continue;
    }
    it(`${JSON.stringify(input)} -> ${JSON.stringify(output)}`, () => {
      expect(canonicalizeMintUrl(input)).toBe(output);
    });
  }

  it("canonical output is a fixed point of itself (row identity is stable)", () => {
    for (const { input } of fixtures.normalizeMintUrl) {
      const once = canonicalizeMintUrl(input);
      expect(canonicalizeMintUrl(once)).toBe(once);
    }
  });
});

describe("mints.golden — mintOriginAndHost (PoC getMintOriginAndHost)", () => {
  for (const { input, output } of fixtures.getMintOriginAndHost) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(output)}`, () => {
      expect(mintOriginAndHost(input)).toEqual(output);
    });
  }
});

describe("mints.golden — mintDisplayName (PoC getMintSelectionDisplayName)", () => {
  for (const { input, output } of fixtures.getMintSelectionDisplayName) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(output)}`, () => {
      expect(mintDisplayName(input)).toBe(output);
    });
  }
});

describe("mints.golden — isTestMintUrl (deliberate superset of the PoC)", () => {
  for (const { input, output } of fixtures.isTestMintUrl) {
    if (TEST_MINT_DIVERGENCES.has(input)) {
      it(`DIVERGES on ${JSON.stringify(input)} (PoC: ${String(output)})`, () => {
        expect(output).toBe(false);
        expect(isTestMintUrl(input)).toBe(true);
      });
      continue;
    }
    it(`${JSON.stringify(input)} -> ${String(output)}`, () => {
      expect(isTestMintUrl(input)).toBe(output);
    });
  }
});

describe("mints.golden — parseMintInfoPayload", () => {
  for (const { name, payload, output } of fixtures.parseMintInfoPayload) {
    it(name, () => {
      expect(parseMintInfoPayload(payload)).toEqual(output);
    });
  }
});

describe("mints.golden — mintInfoIconUrl (PoC getMintInfoIconUrl)", () => {
  for (const { name, mintUrl, infoJson, output } of fixtures.getMintInfoIconUrl) {
    it(name, () => {
      expect(mintInfoIconUrl(mintUrl, infoJson)).toBe(output);
    });
  }
});

describe("mints.golden — resolveNpubCashServerBaseUrl", () => {
  for (const { input, output } of fixtures.resolveNpubCashServerBaseUrl) {
    it(`${JSON.stringify(input)} -> ${output}`, () => {
      expect(resolveNpubCashServerBaseUrl(input)).toBe(output);
    });
  }

  it("collapses the PoC's claim-server preference (same domain mapping)", () => {
    // The PoC picked the claim server once an address was claimed; both
    // bases come from the same domain map, so resolving the user's address
    // yields the very URLs the PoC's resolveMintSyncServerBaseUrl returned.
    const byName = new Map(fixtures.resolveMintSyncServerBaseUrl.map((c) => [c.name, c.output]));
    expect(byName.get("noOwnedAddresses")).toBe(DEFAULT_NPUB_CASH_SERVER_BASE_URL);
    expect(byName.get("ownedAddressPresent")).toBe(resolveNpubCashServerBaseUrl("alice@linky.fit"));
  });
});

describe("mints.golden — NIP-98 mint-sync token (nostr-tools byte parity)", () => {
  const secretKey = hexToBytes(fixtures.nip98.privHex);

  for (const goldenCase of fixtures.nip98.cases) {
    it(`${goldenCase.name}: header + event JSON match byte-for-byte (sig masked)`, async () => {
      const token = await Effect.runPromise(
        buildNip98Token({
          url: goldenCase.request.url,
          method: goldenCase.request.method,
          payload: { mintUrl: canonicalizeMintUrl(goldenCase.inputMintUrl) },
          secretKey,
          nowSec: goldenCase.nowSec,
        }).pipe(Effect.provide(RandomnessFixed)),
      );

      expect(token.startsWith(NIP98_AUTHORIZATION_SCHEME)).toBe(true);
      expect(goldenCase.authorizationScheme).toBe(NIP98_AUTHORIZATION_SCHEME);

      const decoded = Either.getOrThrow(
        Encoding.decodeBase64String(token.slice(NIP98_AUTHORIZATION_SCHEME.length)),
      );
      const masked = decoded.replace(/"sig":"[0-9a-f]{128}"/, '"sig":"SIG"');
      expect(masked).toBe(goldenCase.eventJsonSigMasked);

      // The signature itself is randomized (BIP-340 aux) — verify instead.
      expect(verifyNostrEvent(JSON.parse(decoded) as NostrEvent)).toBe(true);
    });

    it(`${goldenCase.name}: request body bytes match the PoC`, () => {
      const body = JSON.stringify({ mintUrl: canonicalizeMintUrl(goldenCase.inputMintUrl) });
      expect(body).toBe(goldenCase.request.body);
      expect(goldenCase.request.method).toBe("PUT");
      expect(goldenCase.request.contentType).toBe("application/json");
      expect(goldenCase.request.url).toBe(`${goldenCase.baseUrl}/api/v1/info/mint`);
    });
  }
});
