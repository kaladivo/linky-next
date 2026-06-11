/**
 * Public surface of the Effect ↔ React bridge. Components import ONLY from
 * here (hooks + UI state types); appLayer/runtime stay internal to
 * src/runtime/.
 */
export { useEffectQuery } from "./useEffectQuery";
export { useEffectMutation } from "./useEffectMutation";
export { runAppEffect } from "./runAppEffect";
export type { EffectQueryState } from "./queryState";
export type { EffectMutation, EffectMutationState } from "./useEffectMutation";
export type { AppServices } from "./appLayer";
