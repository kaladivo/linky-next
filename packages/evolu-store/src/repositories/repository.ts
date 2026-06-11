/**
 * Repository adapter conventions (issue #15).
 *
 * Repositories are the persistence boundary between `@linky/core` and Evolu.
 * The conventions every repository in this package follows:
 *
 * - **Plain TypeScript interface.** No Evolu types in the public surface:
 *   ids are `string`, timestamps are ISO strings or unix seconds, rows are
 *   plain readonly records. Core will wrap these interfaces as Effect ports
 *   (#25/#35) without ever importing Evolu.
 * - **Typed errors, no throws.** Every expected failure is a tagged object
 *   (`_tag` discriminant, matching core's `Data.TaggedError` convention) in
 *   a {@link RepoResult}. Reads of optional data return `null`, not errors.
 * - **Mutations are synchronous** (Evolu applies them locally and returns a
 *   validation result immediately); **queries are async** (`Promise`).
 * - **Lane routing is internal.** Repositories mutate through
 *   `LinkyStore.insert/update/upsert`, so every row lands on its domain's
 *   owner lane; callers never see owners.
 *
 * `ContactsRepository` is the reference implementation of this pattern.
 */

/** Success/failure result used by repository mutations. Mirrors core's no-throw rule. */
export type RepoResult<A, E> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: E };

export const repoOk = <A>(value: A): { readonly ok: true; readonly value: A } => ({
  ok: true,
  value,
});

export const repoErr = <E>(error: E): { readonly ok: false; readonly error: E } => ({
  ok: false,
  error,
});
