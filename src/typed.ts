// Type-level machinery that turns the machine-generated `paths` interface in
// `schema.ts` into an ergonomic, fully-typed request signature. This is the
// bridge that gives the hand-written client typed coverage of the WHOLE REST
// API (every route in `openapi.json`) instead of only the ~30 curated helpers.
//
// Everything here is types-only — no runtime code, no runtime dependency. The
// generated `schema.ts` is likewise types-only, so adding it costs nothing at
// runtime and cannot drift from the client's behaviour.
//
// See `ForumulateClient.typed()` in `index.ts` for the method these types shape,
// and the header of `schema.ts` for how to regenerate the source `paths`.

import type { paths } from './schema';

export type { paths };

/** HTTP verbs a generated path entry can carry (openapi-typescript's key set). */
export type HttpMethod = 'get' | 'put' | 'post' | 'delete' | 'options' | 'head' | 'patch' | 'trace';

/**
 * The verbs that actually exist on a path. openapi-typescript stamps every
 * absent verb as `put?: never`, so we drop the `never` slots to leave real
 * operations only — this is what powers method autocomplete on `typed()`.
 */
export type MethodsOf<P extends keyof paths> = {
  [M in keyof paths[P]]: paths[P][M] extends never ? never : M extends HttpMethod ? M : never;
}[keyof paths[P]];

/** The generated operation object for a `(path, method)` pair. */
export type OperationOf<P extends keyof paths, M extends keyof paths[P]> = paths[P][M];

/** `true` when `T` has at least one key (used to decide required vs. optional). */
type HasKeys<T> = [keyof T] extends [never] ? false : true;

/** The `params` slot: required when the route has path params, absent otherwise. */
type ParamsPart<Op> = Op extends { parameters: { path: infer P } }
  ? HasKeys<P> extends true
    ? { params: P }
    : { params?: undefined }
  : { params?: undefined };

/**
 * The `query` slot: present when the route declares query params, and required
 * only when the route has at least one REQUIRED one.
 *
 * The required pattern is tested first, then the optional one — the same order
 * and for the same reason as `BodyPart` below. openapi-typescript emits
 * `query?: {…}` (an OPTIONAL property) whenever every query parameter on the
 * route is itself optional, and an optional property does not satisfy
 * `{ query: infer Q }`. Matching only the required form therefore fell through
 * to `{ query?: undefined }` and made `typed()` REFUSE a perfectly legal query
 * argument on every such route — which is most of them: of 1,220 operations,
 * the ones with all-optional query params are the common case.
 *
 * `GET /orgs/{orgId}/spaces` is the case that caught it: `deleted`, `limit` and
 * `cursor` are all optional, so passing any of them was a type error even
 * though the route has always accepted them. `ParamsPart` above is unaffected
 * only by luck — a path parameter is never optional, so it is always emitted in
 * the required form.
 *
 * `NonNullable` strips the `| undefined` that inferring through an optional
 * property adds, so `HasKeys` sees the object rather than a union with
 * `undefined` (which would otherwise always look like it has keys).
 */
type QueryPart<Op> = Op extends { parameters: { query: infer Q } }
  ? HasKeys<NonNullable<Q>> extends true
    ? { query: NonNullable<Q> }
    : { query?: undefined }
  : Op extends { parameters: { query?: infer Q } }
    ? HasKeys<NonNullable<Q>> extends true
      ? { query?: NonNullable<Q> }
      : { query?: undefined }
    : { query?: undefined };

/**
 * The `body` slot. A required `requestBody` (no `?` in the schema) yields a
 * required `body`; an optional one yields an optional `body`. The required
 * pattern is tested first because an optional `requestBody` does not satisfy it.
 */
type BodyPart<Op> = Op extends { requestBody: { content: { 'application/json': infer B } } }
  ? { body: B }
  : Op extends { requestBody?: { content: { 'application/json': infer B } } }
    ? { body?: B }
    : { body?: undefined };

/** Flatten an intersection into a single object literal for readable hovers. */
type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * The `init` argument for `typed(method, path, init)`, derived from the route:
 * path params, query params and JSON body are each required exactly when the
 * spec says so, plus a `raw` escape to get the untouched `Response` back and
 * `headers` for the two the API expects per call.
 *
 * `headers` is deliberately a free `Record` rather than inferred from the
 * spec's header parameters: `Idempotency-Key` is declared on the operations
 * that honour it and `Forumulate-Version` applies to all of them, but the
 * generated `paths` carries header params inconsistently across 1,225
 * operations, and a type that refuses a legal header is worse than one that
 * does not narrow it. Without this slot there was no way to send either, so
 * `POST …/items` — which REQUIRES `Idempotency-Key` — could not be called at
 * all from the typed surface that advertised it.
 */
export type TypedRequestInit<Op> = Simplify<
  ParamsPart<Op> &
    QueryPart<Op> &
    BodyPart<Op> & { raw?: boolean; headers?: Record<string, string> }
>;

/** Pull the `application/json` payload out of one response entry. */
type JsonBody<R> = R extends { content: { 'application/json': infer D } } ? D : unknown;

/**
 * The success payload for a route: the 200, then 201, then 202 body, or
 * `undefined` for a 204. Routes whose spec response is empty resolve to
 * `unknown` — the value is still whatever the API returns, just not narrowed.
 */
export type TypedResponse<Op> = Op extends { responses: infer R }
  ? 200 extends keyof R
    ? JsonBody<R[200]>
    : 201 extends keyof R
      ? JsonBody<R[201]>
      : 202 extends keyof R
        ? JsonBody<R[202]>
        : 204 extends keyof R
          ? undefined
          : unknown
  : unknown;
