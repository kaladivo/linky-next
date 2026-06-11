/**
 * Linky Evolu schema module.
 *
 * This is the single place that defines the Evolu database schema. The real
 * domain schema (contacts, wallet, messages, transactions, identity, meta)
 * lands with issue #15; until then the schema carries one minimal table used
 * by the storage spike (issue #9). Evolu schema evolution is additive, so
 * extending this object later is safe.
 */
import { id, NonEmptyString1000 } from "@evolu/common";

export const SpikeNoteId = id("SpikeNote");
export type SpikeNoteId = typeof SpikeNoteId.Type;

export const linkySchema = {
  spikeNote: {
    id: SpikeNoteId,
    content: NonEmptyString1000,
  },
};

export type LinkySchema = typeof linkySchema;
