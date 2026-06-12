/**
 * PushSender — the delivery transport behind a service tag so the watcher
 * tests run against a fake.
 *
 * Live implementation: plain HTTP to the Expo push API (the mobile app is
 * an Expo app; #52 registers `ExponentPushToken[...]` device tokens). No
 * `expo-server-sdk` dependency — the API is a single JSON POST and the SDK
 * would only add retry/queue machinery we handle ourselves.
 *
 * Notification copy is deliberately generic: the service cannot decrypt
 * anything, so rich copy (sender, amount, content) is produced on-device by
 * the app (notifications.md contract); the payload carries only the outer
 * event id and the recipient pubkey so the app can sync and re-render.
 */
import { Context, Effect, Layer } from "effect";

export interface PushMessage {
  /** Expo push token (`ExponentPushToken[...]`). */
  readonly to: string;
  readonly title: string;
  readonly body: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export type PushOutcome =
  /** Accepted by Expo. */
  | "ok"
  /** Token is permanently dead — the caller should drop registrations. */
  | "device-not-registered"
  /** Transient failure (network, 5xx, malformed response). Not retried. */
  | "failed";

export interface PushSendResult {
  readonly token: string;
  readonly outcome: PushOutcome;
}

export interface PushSenderService {
  /** Never fails; per-token outcomes instead. */
  readonly send: (
    messages: ReadonlyArray<PushMessage>,
  ) => Effect.Effect<ReadonlyArray<PushSendResult>>;
}

export class PushSender extends Context.Tag("@linky/push/PushSender")<
  PushSender,
  PushSenderService
>() {}

// ---------------------------------------------------------------------------
// Expo HTTP implementation
// ---------------------------------------------------------------------------

const EXPO_CHUNK_SIZE = 100;

interface ExpoTicket {
  readonly status?: string;
  readonly details?: { readonly error?: string };
}

const sendChunk = async (
  url: string,
  accessToken: string | null,
  chunk: ReadonlyArray<PushMessage>,
): Promise<Array<PushSendResult>> => {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(accessToken === null ? {} : { authorization: `Bearer ${accessToken}` }),
      },
      body: JSON.stringify(
        chunk.map((message) => ({
          to: message.to,
          title: message.title,
          body: message.body,
          data: message.data,
          sound: "default",
          priority: "high",
        })),
      ),
    });
    if (!response.ok) {
      return chunk.map((message) => ({ token: message.to, outcome: "failed" as const }));
    }
    const payload = (await response.json()) as { data?: ReadonlyArray<ExpoTicket> };
    const tickets = payload.data ?? [];
    return chunk.map((message, index) => {
      const ticket = tickets[index];
      if (ticket === undefined) return { token: message.to, outcome: "failed" as const };
      if (ticket.status === "ok") return { token: message.to, outcome: "ok" as const };
      return {
        token: message.to,
        outcome:
          ticket.details?.error === "DeviceNotRegistered"
            ? ("device-not-registered" as const)
            : ("failed" as const),
      };
    });
  } catch {
    return chunk.map((message) => ({ token: message.to, outcome: "failed" as const }));
  }
};

export const makeExpoPushSender = (options: {
  readonly expoPushUrl: string;
  readonly expoAccessToken: string | null;
}): PushSenderService => ({
  send: (messages) =>
    Effect.promise(async () => {
      const results: Array<PushSendResult> = [];
      for (let start = 0; start < messages.length; start += EXPO_CHUNK_SIZE) {
        const chunk = messages.slice(start, start + EXPO_CHUNK_SIZE);
        results.push(...(await sendChunk(options.expoPushUrl, options.expoAccessToken, chunk)));
      }
      return results;
    }),
});

export const layerExpoPushSender = (options: {
  readonly expoPushUrl: string;
  readonly expoAccessToken: string | null;
}): Layer.Layer<PushSender> => Layer.succeed(PushSender, makeExpoPushSender(options));
