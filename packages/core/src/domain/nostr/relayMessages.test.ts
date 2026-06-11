import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import type { ClientMessage, RelayMessage } from "./relayMessages.js";
import {
  decodeClientMessage,
  decodeRelayMessage,
  encodeClientMessage,
  encodeRelayMessage,
} from "./relayMessages.js";
import { makeSignedEvent } from "./nostrTestKit.js";

describe("client message codec", () => {
  it("round-trips EVENT / REQ / CLOSE", async () => {
    const event = await Effect.runPromise(makeSignedEvent());
    const messages: ReadonlyArray<ClientMessage> = [
      { _tag: "ClientEventMessage", event },
      {
        _tag: "ClientReqMessage",
        subscriptionId: "sub-1",
        filters: [{ kinds: [1, 14], "#p": [event.pubkey] }, { ids: [event.id] }],
      },
      { _tag: "ClientCloseMessage", subscriptionId: "sub-1" },
    ];
    for (const message of messages) {
      const decoded = decodeClientMessage(encodeClientMessage(message));
      expect(decoded).toStrictEqual(Option.some(message));
    }
  });

  it("encodes the NIP-01 wire shape", async () => {
    const event = await Effect.runPromise(makeSignedEvent());
    expect(JSON.parse(encodeClientMessage({ _tag: "ClientEventMessage", event }))).toStrictEqual([
      "EVENT",
      event,
    ]);
    expect(
      JSON.parse(
        encodeClientMessage({
          _tag: "ClientReqMessage",
          subscriptionId: "s",
          filters: [{ kinds: [0] }],
        }),
      ),
    ).toStrictEqual(["REQ", "s", { kinds: [0] }]);
  });
});

describe("relay message codec", () => {
  it("round-trips EVENT / OK / EOSE / CLOSED / NOTICE / AUTH", async () => {
    const event = await Effect.runPromise(makeSignedEvent());
    const messages: ReadonlyArray<RelayMessage> = [
      { _tag: "RelayEventMessage", subscriptionId: "sub-9", event },
      { _tag: "RelayOkMessage", eventId: event.id, accepted: true, message: "" },
      { _tag: "RelayOkMessage", eventId: event.id, accepted: false, message: "blocked: spam" },
      { _tag: "RelayEoseMessage", subscriptionId: "sub-9" },
      { _tag: "RelayClosedMessage", subscriptionId: "sub-9", message: "auth-required" },
      { _tag: "RelayNoticeMessage", message: "slow down" },
      { _tag: "RelayAuthMessage", challenge: "nonce" },
    ];
    for (const message of messages) {
      const decoded = decodeRelayMessage(encodeRelayMessage(message));
      expect(decoded).toStrictEqual(Option.some(message));
    }
  });

  it("tolerates malformed frames by decoding to none", async () => {
    const event = await Effect.runPromise(makeSignedEvent());
    const malformed = [
      "not json at all",
      '"just a string"',
      "{}",
      "[]",
      '["WEIRD", 1]',
      '["EVENT"]',
      '["EVENT", 42, {}]',
      `["EVENT", "sub", {"id": "nope"}]`,
      `["OK", "${event.id}", "yes", ""]`,
      '["NOTICE", 7]',
      '["EOSE", null]',
    ];
    for (const frame of malformed) {
      expect(decodeRelayMessage(frame)).toStrictEqual(Option.none());
    }
    expect(decodeClientMessage('["REQ", "sub", "not a filter"]')).toStrictEqual(Option.none());
    expect(decodeClientMessage('["EVENT", {"id": "nope"}]')).toStrictEqual(Option.none());
  });
});
