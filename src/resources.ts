/**
 * The resource namespaces — `client.forum.topics.list({ orgId, spaceId })` —
 * built from the generated route table (`operations.gen.ts`) and typed from
 * the generated `operations` interface (`schema.ts`).
 *
 * Nothing here names a route. Placement and method names come from the
 * operationIds (`<Tag>_<method>`), so the SDK cannot drift from the spec: a
 * refresh of `openapi.json` followed by `generate-operations` is the whole
 * change, and `coverage.test.ts` fails if the two disagree.
 *
 * Call shape, for every method:
 *
 *   method({ ...pathParams, query?, body?, headers?, idempotencyKey?, signal?, maxRetries? })
 *
 * Path params sit at the top level because every call has them and they are
 * never optional; `query` and `body` are nested because their names are the
 * API's and could collide with anything. An argument that is none of these is
 * refused rather than dropped: `{ orgId, limit: 5 }` would otherwise read as
 * "limit honoured" while sending no limit at all.
 */
import type { operations } from './schema';
import type { CallOptions } from './http';
import type { PagePromise } from './pagination';
import type { QueryPart, Simplify } from './typed';
import { OPERATIONS, PATH_PREFIXES } from './operations.gen';

// ── Types ────────────────────────────────────────────────────────────────────

type Ops = typeof OPERATIONS;
export type OperationTag = keyof Ops;
export type OperationId = keyof operations & string;
type Op<K> = K extends keyof operations ? operations[K] : never;
type HasKeys<T> = [keyof T] extends [never] ? false : true;

type PathPart<O> = O extends { parameters: { path: infer P } }
  ? HasKeys<P> extends true
    ? P
    : unknown
  : unknown;

type BodyContent<R> = R extends { content: infer C }
  ? C extends { 'application/json': infer B }
    ? B
    : C extends { 'multipart/form-data': unknown }
      ? FormData
      : unknown
  : unknown;
type BodyPart<O> = O extends { requestBody: infer R }
  ? { body: BodyContent<R> }
  : O extends { requestBody?: infer R }
    ? [NonNullable<R>] extends [never]
      ? { body?: undefined }
      : { body?: BodyContent<NonNullable<R>> }
    : { body?: undefined };

/** The one argument of a namespace method / `request(operationId, args)`. */
export type OperationArgs<K extends OperationId> = Simplify<
  PathPart<Op<K>> & QueryPart<Op<K>> & BodyPart<Op<K>> & CallOptions
>;
/** `{}` is assignable exactly when every key of the argument is optional. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type NoneRequired<T> = {} extends T ? true : false;
export type OperationArgsTuple<K extends OperationId> =
  NoneRequired<OperationArgs<K>> extends true
    ? [args?: OperationArgs<K>]
    : [args: OperationArgs<K>];
/** Operations whose argument may be left out entirely (no path params, nothing required). */
export type OptionalArgsOperationId = {
  [K in OperationId]: NoneRequired<OperationArgs<K>> extends true ? K : never;
}[OperationId];

type Success<O> = O extends { responses: infer R }
  ? 200 extends keyof R
    ? R[200]
    : 201 extends keyof R
      ? R[201]
      : 202 extends keyof R
        ? R[202]
        : 204 extends keyof R
          ? { content?: never }
          : unknown
  : unknown;
type Payload<E> = E extends { content: infer C }
  ? C extends { 'application/json': infer D }
    ? D
    : C extends { 'text/event-stream': unknown } | { '*/*': unknown }
      ? Response
      : keyof C extends `text/${string}`
        ? string
        : Response
  : E extends { content?: never }
    ? undefined
    : unknown;

/** What a call resolves to: the JSON body, a `string` for text, a `Response` for binary. */
export type OperationResult<K extends OperationId> = Payload<Success<Op<K>>>;

type IsPaged<O> = O extends { parameters: { query?: infer Q } }
  ? [NonNullable<Q>] extends [never]
    ? false
    : 'cursor' extends keyof NonNullable<Q>
      ? true
      : false
  : false;
type RowOf<P> = [Extract<P, { data: readonly unknown[] }>] extends [never]
  ? unknown
  : Extract<P, { data: readonly unknown[] }>['data'][number];

/** The element a `for await` over this operation yields. */
export type OperationRow<K extends OperationId> = RowOf<OperationResult<K>>;
export type PagedOperationId = {
  [K in OperationId]: IsPaged<Op<K>> extends true ? K : never;
}[OperationId];

/**
 * A paged list answers either the pre-envelope body or the envelope, by the
 * version stated. The generated door always states one, so it always gets the
 * envelope: narrow to it rather than make every caller test for `page`.
 */
type Enveloped<P> = [Extract<P, { page: unknown }>] extends [never]
  ? P
  : Extract<P, { page: unknown }>;
export type OperationReturn<K extends OperationId> =
  IsPaged<Op<K>> extends true
    ? PagePromise<Enveloped<OperationResult<K>>, OperationRow<K>>
    : Promise<OperationResult<K>>;
export type OperationFn<K extends OperationId> = ((
  ...args: OperationArgsTuple<K>
) => OperationReturn<K>) & {
  readonly operationId: K;
};

/** Twin of `camel` in scripts/generate-operations.mjs. */
type IdFor<T extends string, M extends string, V> = V extends `=${infer S} ${string}`
  ? `${T}_${S}`
  : `${T}_${M}`;
type TagMethods<T extends OperationTag> = {
  -readonly [M in keyof Ops[T][1] & string]: OperationFn<IdFor<T, M, Ops[T][1][M]> & OperationId>;
};
type Placement = { [T in OperationTag]: Ops[T][0] }[OperationTag];
type TagAt<P extends string> = {
  [T in OperationTag]: Ops[T][0] extends P ? T : never;
}[OperationTag];
type MethodsAt<P extends string> = [TagAt<P>] extends [never]
  ? Record<never, never>
  : TagMethods<TagAt<P>>;
type SubsOf<N extends string> = Placement extends infer P
  ? P extends `${N}.${infer S}`
    ? S
    : never
  : never;

export type NamespaceName = Placement extends infer P
  ? P extends `${infer N}.${string}`
    ? N
    : P
  : never;
export type Namespace<N extends NamespaceName> = MethodsAt<N> & {
  readonly [S in SubsOf<N>]: MethodsAt<`${N}.${S}`>;
};
export type Resources = { readonly [N in NamespaceName]: Namespace<N> };

/**
 * A generated namespace with the 0.5 positional helpers laid over it.
 *
 * Where a helper and a generated method share a name they are the same
 * operation (`coverage.test.ts` holds that), and the member answers BOTH call
 * shapes: `spaces.list('acme')` as in 0.5, `spaces.list({ orgId: 'acme' })` as
 * every generated method — so the new style is uniform without breaking a
 * single 0.5 call. A helper with no generated twin keeps its name; a helper
 * object (`content.model`) is merged one level down.
 */
type AnyFn = (...a: never[]) => unknown;
type MergeMember<G, H> = H extends AnyFn
  ? G extends AnyFn
    ? G & H
    : H
  : G extends AnyFn
    ? H
    : Omit<G, keyof H> & { [K in keyof H]: K extends keyof G ? MergeMember<G[K], H[K]> : H[K] };
export type Merged<G, H> = Omit<G, keyof H> & {
  [K in keyof H]: K extends keyof G ? MergeMember<G[K], H[K]> : H[K];
};

// ── Runtime ──────────────────────────────────────────────────────────────────

export interface Route {
  id: string;
  method: string;
  path: string;
  /** p = paged, b = binary, t = text, m = multipart (see operations.gen.ts). */
  flags: string;
}
export type Invoke = (route: Route, args: Record<string, unknown> | undefined) => unknown;

interface Table {
  /** operationId → route. */
  byId: Map<string, Route>;
  /** placement (`forum`, `forum.topics`) → method name → route. */
  byPlacement: Map<string, Map<string, Route>>;
}
let table: Table | undefined;

/** Parsed once per process, on first use; the generated table is data only. */
export function routeTable(): Table {
  if (table) return table;
  const byId = new Map<string, Route>();
  const byPlacement = new Map<string, Map<string, Route>>();
  for (const [tag, [placement, methods]] of Object.entries(OPERATIONS) as [
    string,
    readonly [string, Record<string, string>],
  ][]) {
    const at = new Map<string, Route>();
    for (const [name, spec] of Object.entries(methods)) {
      let rest = spec;
      let suffix = name;
      if (rest.startsWith('=')) {
        const cut = rest.indexOf(' ');
        suffix = rest.slice(1, cut);
        rest = rest.slice(cut + 1);
      }
      const [method = 'GET', short = '', flags = ''] = rest.split(' ');
      const pre = short.slice(0, 2) as keyof typeof PATH_PREFIXES;
      const path = short.startsWith('~') ? PATH_PREFIXES[pre] + short.slice(2) : short;
      const id = `${tag}_${suffix}`;
      const route = byId.get(id) ?? { id, method, path, flags };
      byId.set(id, route);
      at.set(name, route);
    }
    byPlacement.set(placement, at);
  }
  return (table = { byId, byPlacement });
}

export function namespaceNames(): string[] {
  return [...new Set([...routeTable().byPlacement.keys()].map((p) => p.split('.')[0]!))];
}

function methodsOf(placement: string, invoke: Invoke): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, route] of routeTable().byPlacement.get(placement) ?? []) {
    const fn = (args?: Record<string, unknown>) => invoke(route, args);
    // Which operation a method calls, readable at runtime (`client.blog.list.operationId`):
    // for logs, and for the coverage test that proves every operation is reachable.
    Object.defineProperty(fn, 'operationId', { value: route.id });
    out[name] = fn;
  }
  return out;
}

/** One namespace's methods and sub-namespaces, as plain objects of closures. */
export function buildNamespace(name: string, invoke: Invoke): Record<string, unknown> {
  const ns = methodsOf(name, invoke);
  for (const placement of routeTable().byPlacement.keys()) {
    if (placement.startsWith(name + '.'))
      ns[placement.slice(name.length + 1)] = methodsOf(placement, invoke);
  }
  return ns;
}

const OPTION_KEYS = new Set(['query', 'body', 'headers', 'idempotencyKey', 'signal', 'maxRetries']);

type Marked = ((...a: unknown[]) => unknown) & { operationId?: string };

/**
 * One member, two call shapes. A call with no arguments, or with one object
 * whose keys are all path params / call options of the operation, is the
 * generated shape; anything else (a string first, a 0.5 input object such as
 * `orgs.create({ name, slug })`) goes to the helper.
 */
function dual(gen: Marked, helper: Marked): Marked {
  const route = routeTable().byId.get(gen.operationId!)!;
  const keys = new Set([
    ...(route.path.match(/\{([^}]+)\}/g) ?? []).map((p) => p.slice(1, -1)),
    ...OPTION_KEYS,
  ]);
  const fn = (...args: unknown[]) => {
    const [a] = args;
    const generated =
      args.length === 0 ||
      (args.length === 1 &&
        !!a &&
        typeof a === 'object' &&
        Object.keys(a).every((k) => keys.has(k)));
    return generated ? gen(a) : helper(...args);
  };
  Object.defineProperty(fn, 'operationId', { value: gen.operationId });
  // The 0.5 helper itself, so the coverage walk can prove both halves call the same route.
  Object.defineProperty(fn, 'positional', { value: helper });
  return fn;
}

/** Lay hand-written helpers over a generated namespace; see `Merged`. */
export function mergeNamespace(
  gen: Record<string, unknown>,
  hw: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...gen };
  for (const [k, v] of Object.entries(hw)) {
    const g = out[k];
    if (typeof g === 'function' && typeof v === 'function') out[k] = dual(g as Marked, v as Marked);
    else if (g && typeof g === 'object' && v && typeof v === 'object') {
      out[k] = mergeNamespace(g as Record<string, unknown>, v as Record<string, unknown>);
    } else out[k] = v;
  }
  return out;
}

/** Split a call's argument into the filled path and the request options. */
export function resolveArgs(route: Route, args: Record<string, unknown> = {}) {
  const used = new Set<string>();
  const path = route.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const v = args[name];
    if (v === undefined || v === null || v === '') {
      throw new TypeError(`${route.id}: missing path parameter "${name}"`);
    }
    used.add(name);
    return encodeURIComponent(String(v));
  });
  for (const k of Object.keys(args)) {
    if (!used.has(k) && !OPTION_KEYS.has(k)) {
      throw new TypeError(
        `${route.id}: unknown argument "${k}" — query parameters go under \`query\`, the request body under \`body\``,
      );
    }
  }
  return {
    path,
    query: args.query as Record<string, unknown> | undefined,
    body: args.body,
    headers: args.headers as Record<string, string> | undefined,
    idempotencyKey: args.idempotencyKey as string | undefined,
    signal: args.signal as AbortSignal | undefined,
    maxRetries: args.maxRetries as number | undefined,
  };
}
