import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { matchesAnyFilter, matchesFilter } from "./filter.js";
import { makeSignedEvent } from "./nostrTestKit.js";

const event = await Effect.runPromise(
  makeSignedEvent({
    kind: 14,
    created_at: 1_718_000_100,
    tags: [
      ["p", "aa".repeat(32)],
      ["e", "bb".repeat(32), "", "root"],
    ],
    content: "filtered",
  }),
);

describe("matchesFilter", () => {
  it("matches on ids / authors / kinds", () => {
    expect(matchesFilter(event, {})).toBe(true);
    expect(matchesFilter(event, { ids: [event.id] })).toBe(true);
    expect(matchesFilter(event, { ids: ["00".repeat(32)] })).toBe(false);
    expect(matchesFilter(event, { authors: [event.pubkey] })).toBe(true);
    expect(matchesFilter(event, { authors: ["00".repeat(32)] })).toBe(false);
    expect(matchesFilter(event, { kinds: [14, 1] })).toBe(true);
    expect(matchesFilter(event, { kinds: [1] })).toBe(false);
  });

  it("matches on time bounds", () => {
    expect(matchesFilter(event, { since: event.created_at })).toBe(true);
    expect(matchesFilter(event, { since: event.created_at + 1 })).toBe(false);
    expect(matchesFilter(event, { until: event.created_at })).toBe(true);
    expect(matchesFilter(event, { until: event.created_at - 1 })).toBe(false);
  });

  it("matches on tag queries", () => {
    expect(matchesFilter(event, { "#p": ["aa".repeat(32)] })).toBe(true);
    expect(matchesFilter(event, { "#p": ["cc".repeat(32)] })).toBe(false);
    expect(matchesFilter(event, { "#e": ["bb".repeat(32)] })).toBe(true);
    expect(matchesFilter(event, { "#x": ["anything"] })).toBe(false);
    expect(matchesFilter(event, { kinds: [14], "#p": ["aa".repeat(32)] })).toBe(true);
  });

  it("requires all conditions of one filter; any filter of a set", () => {
    expect(matchesFilter(event, { kinds: [14], authors: ["00".repeat(32)] })).toBe(false);
    expect(matchesAnyFilter(event, [{ kinds: [1] }, { ids: [event.id] }])).toBe(true);
    expect(matchesAnyFilter(event, [{ kinds: [1] }, { ids: ["00".repeat(32)] }])).toBe(false);
    expect(matchesAnyFilter(event, [])).toBe(false);
  });
});
