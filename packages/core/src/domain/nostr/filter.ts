/**
 * NostrFilter — NIP-01 subscription filters and local event matching.
 *
 * `matchesFilter` implements the standard relay-side matching rules; it is
 * used by the in-memory fake relay and available to domain code that needs
 * to classify events client-side. `limit` is a query-time hint and does not
 * participate in matching.
 */
import type { NostrEvent } from "./NostrEvent.js";

export interface NostrFilter {
  readonly ids?: ReadonlyArray<string>;
  readonly authors?: ReadonlyArray<string>;
  readonly kinds?: ReadonlyArray<number>;
  readonly since?: number;
  readonly until?: number;
  readonly limit?: number;
  /** Tag queries, e.g. `"#p": [pubkeyHex]` — event must carry a matching tag. */
  readonly [tagQuery: `#${string}`]: ReadonlyArray<string> | number | undefined;
}

const eventHasTagValue = (
  event: NostrEvent,
  tagName: string,
  values: ReadonlyArray<string>,
): boolean =>
  event.tags.some((tag) => tag[0] === tagName && tag[1] !== undefined && values.includes(tag[1]));

export const matchesFilter = (event: NostrEvent, filter: NostrFilter): boolean => {
  if (filter.ids !== undefined && !filter.ids.includes(event.id)) return false;
  if (filter.authors !== undefined && !filter.authors.includes(event.pubkey)) return false;
  if (filter.kinds !== undefined && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  for (const key of Object.keys(filter)) {
    if (!key.startsWith("#")) continue;
    const values = filter[key as `#${string}`];
    if (!Array.isArray(values)) continue;
    if (!eventHasTagValue(event, key.slice(1), values)) return false;
  }
  return true;
};

export const matchesAnyFilter = (event: NostrEvent, filters: ReadonlyArray<NostrFilter>): boolean =>
  filters.some((filter) => matchesFilter(event, filter));
