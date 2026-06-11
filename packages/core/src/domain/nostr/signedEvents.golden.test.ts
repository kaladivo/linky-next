/**
 * Golden tests for NIP-01 event id + signature compatibility (issue #21).
 *
 * The fixtures in `__fixtures__/signedEvents.golden.json` were generated
 * FROM THE POC's actual dependency (nostr-tools@2.23.5) before this
 * implementation was written — see `__fixtures__/README.md`. They prove:
 *
 *   - same template + key -> byte-identical event id as nostr-tools
 *   - signatures produced by nostr-tools verify under our verifier
 *   - our own signatures over the same templates are valid BIP-340
 */
import { readFileSync } from "node:fs";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import type { NostrEvent } from "./NostrEvent.js";
import {
  decodeNostrEventOption,
  nostrEventId,
  signNostrEvent,
  verifyNostrEvent,
} from "./NostrEvent.js";
import { RandomnessFixed, hexToBytes } from "./nostrTestKit.js";

interface GoldenFixtures {
  readonly generator: string;
  readonly secretKeyHex: string;
  readonly publicKeyHex: string;
  readonly events: ReadonlyArray<{ readonly name: string; readonly event: NostrEvent }>;
}

const fixtures = JSON.parse(
  readFileSync(new URL("./__fixtures__/signedEvents.golden.json", import.meta.url), "utf8"),
) as GoldenFixtures;

describe("signedEvents.golden (nostr-tools compatibility)", () => {
  for (const { name, event } of fixtures.events) {
    it(`${name}: fixture decodes, verifies, and id matches our serialization`, () => {
      expect(Option.isSome(decodeNostrEventOption(event))).toBe(true);
      expect(nostrEventId(event)).toBe(event.id);
      expect(verifyNostrEvent(event)).toBe(true);
    });

    it(`${name}: our signer reproduces the same id with a valid signature`, async () => {
      const ours = await Effect.runPromise(
        signNostrEvent(
          {
            kind: event.kind,
            created_at: event.created_at,
            tags: event.tags,
            content: event.content,
          },
          hexToBytes(fixtures.secretKeyHex),
        ).pipe(Effect.provide(RandomnessFixed)),
      );
      expect(ours.pubkey).toBe(fixtures.publicKeyHex);
      expect(ours.id).toBe(event.id);
      // sig differs from the fixture (random aux in nostr-tools) but must verify
      expect(verifyNostrEvent(ours)).toBe(true);
    });
  }
});
