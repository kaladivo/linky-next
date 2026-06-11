/**
 * @linky/core — Effect-based domain logic and protocol workflows for Linky.
 *
 * This is a scaffold stub. Domain workflows (identity derivation, Cashu token
 * lifecycle, Lightning/LNURL, NIP-17 messaging, contacts, mints) land in later
 * issues. Side effects enter only through ports (Effect service tags); this
 * package never imports React, Expo, the Evolu runtime, or platform code.
 */

/** Package version marker until real exports exist. */
export const CORE_PACKAGE_NAME = "@linky/core";

/**
 * Formats an integer satoshi amount with thousands separators, e.g. 21000 -> "21 000 sats".
 * Trivial placeholder so the package has something real to type, lint, and test.
 */
export const formatSats = (amount: number): string => {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new RangeError("amount must be a non-negative safe integer");
  }
  const grouped = amount.toLocaleString("en-US").replaceAll(",", " ");
  return `${grouped} sats`;
};
