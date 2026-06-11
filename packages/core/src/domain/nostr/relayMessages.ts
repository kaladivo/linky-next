/**
 * relayMessages — the NIP-01 client/relay wire protocol codec.
 *
 * Both directions are implemented because core hosts both ends: the relay
 * pool speaks the client side over the `NostrTransport` port, and the
 * in-memory fake relay (tests) speaks the relay side.
 *
 * Decoding is tolerant: an unknown or malformed frame decodes to
 * `Option.none()` and is ignored by the pool — a misbehaving relay must
 * never crash the client.
 */
import { Option } from "effect";

import type { NostrFilter } from "./filter.js";
import type { NostrEvent } from "./NostrEvent.js";
import { decodeNostrEventOption } from "./NostrEvent.js";

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { readonly _tag: "ClientEventMessage"; readonly event: NostrEvent }
  | {
      readonly _tag: "ClientReqMessage";
      readonly subscriptionId: string;
      readonly filters: ReadonlyArray<NostrFilter>;
    }
  | { readonly _tag: "ClientCloseMessage"; readonly subscriptionId: string };

export type RelayMessage =
  | {
      readonly _tag: "RelayEventMessage";
      readonly subscriptionId: string;
      readonly event: NostrEvent;
    }
  | {
      readonly _tag: "RelayOkMessage";
      readonly eventId: string;
      readonly accepted: boolean;
      readonly message: string;
    }
  | { readonly _tag: "RelayEoseMessage"; readonly subscriptionId: string }
  | {
      readonly _tag: "RelayClosedMessage";
      readonly subscriptionId: string;
      readonly message: string;
    }
  | { readonly _tag: "RelayNoticeMessage"; readonly message: string }
  | { readonly _tag: "RelayAuthMessage"; readonly challenge: string };

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

export const encodeClientMessage = (message: ClientMessage): string => {
  switch (message._tag) {
    case "ClientEventMessage":
      return JSON.stringify(["EVENT", message.event]);
    case "ClientReqMessage":
      return JSON.stringify(["REQ", message.subscriptionId, ...message.filters]);
    case "ClientCloseMessage":
      return JSON.stringify(["CLOSE", message.subscriptionId]);
  }
};

export const encodeRelayMessage = (message: RelayMessage): string => {
  switch (message._tag) {
    case "RelayEventMessage":
      return JSON.stringify(["EVENT", message.subscriptionId, message.event]);
    case "RelayOkMessage":
      return JSON.stringify(["OK", message.eventId, message.accepted, message.message]);
    case "RelayEoseMessage":
      return JSON.stringify(["EOSE", message.subscriptionId]);
    case "RelayClosedMessage":
      return JSON.stringify(["CLOSED", message.subscriptionId, message.message]);
    case "RelayNoticeMessage":
      return JSON.stringify(["NOTICE", message.message]);
    case "RelayAuthMessage":
      return JSON.stringify(["AUTH", message.challenge]);
  }
};

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

const parseJsonArray = (frame: string): Option.Option<ReadonlyArray<unknown>> => {
  try {
    const parsed: unknown = JSON.parse(frame);
    return Array.isArray(parsed) ? Option.some(parsed) : Option.none();
  } catch {
    return Option.none();
  }
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const decodeRelayMessage = (frame: string): Option.Option<RelayMessage> =>
  Option.flatMap(parseJsonArray(frame), (parts): Option.Option<RelayMessage> => {
    switch (parts[0]) {
      case "EVENT": {
        const [, subscriptionId, payload] = parts;
        if (typeof subscriptionId !== "string") return Option.none();
        return Option.map(decodeNostrEventOption(payload), (event) => ({
          _tag: "RelayEventMessage" as const,
          subscriptionId,
          event,
        }));
      }
      case "OK": {
        const [, eventId, accepted, message] = parts;
        if (typeof eventId !== "string" || typeof accepted !== "boolean") return Option.none();
        return Option.some({
          _tag: "RelayOkMessage" as const,
          eventId,
          accepted,
          message: typeof message === "string" ? message : "",
        });
      }
      case "EOSE": {
        const [, subscriptionId] = parts;
        if (typeof subscriptionId !== "string") return Option.none();
        return Option.some({ _tag: "RelayEoseMessage" as const, subscriptionId });
      }
      case "CLOSED": {
        const [, subscriptionId, message] = parts;
        if (typeof subscriptionId !== "string") return Option.none();
        return Option.some({
          _tag: "RelayClosedMessage" as const,
          subscriptionId,
          message: typeof message === "string" ? message : "",
        });
      }
      case "NOTICE": {
        const [, message] = parts;
        if (typeof message !== "string") return Option.none();
        return Option.some({ _tag: "RelayNoticeMessage" as const, message });
      }
      case "AUTH": {
        const [, challenge] = parts;
        if (typeof challenge !== "string") return Option.none();
        return Option.some({ _tag: "RelayAuthMessage" as const, challenge });
      }
      default:
        return Option.none();
    }
  });

/**
 * Relay-side decoding of client frames. Filters are shape-checked as plain
 * objects only — this direction exists for the in-memory fake relay, which
 * trusts its own test inputs.
 */
export const decodeClientMessage = (frame: string): Option.Option<ClientMessage> =>
  Option.flatMap(parseJsonArray(frame), (parts): Option.Option<ClientMessage> => {
    switch (parts[0]) {
      case "EVENT":
        return Option.map(decodeNostrEventOption(parts[1]), (event) => ({
          _tag: "ClientEventMessage" as const,
          event,
        }));
      case "REQ": {
        const [, subscriptionId, ...filters] = parts;
        if (typeof subscriptionId !== "string") return Option.none();
        if (!filters.every(isPlainObject)) return Option.none();
        return Option.some({
          _tag: "ClientReqMessage" as const,
          subscriptionId,
          filters: filters as ReadonlyArray<NostrFilter>,
        });
      }
      case "CLOSE": {
        const [, subscriptionId] = parts;
        if (typeof subscriptionId !== "string") return Option.none();
        return Option.some({ _tag: "ClientCloseMessage" as const, subscriptionId });
      }
      default:
        return Option.none();
    }
  });
