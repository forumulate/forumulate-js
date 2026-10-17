/**
 * Every operation in the spec is a method — proven, not promised.
 *
 * The SDK once advertised "typed coverage of the whole API" while 30 of its
 * methods were the only ergonomic ones and a route added after them was
 * invisible. These walks run over the committed `openapi.json`, so a new route
 * that has no method, a helper that hides a different route than the one it
 * shadows, or a route table nobody regenerated fails here, by name.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ForumulateClient, SDK_VERSION, API_VERSION } from './index';
import { namespaceNames, routeTable, type Route } from './resources';

const root = join(__dirname, '..');
const spec = JSON.parse(readFileSync(join(root, 'openapi.json'), 'utf8')) as {
  paths: Record<string, Record<string, { operationId?: string }>>;
  components?: { parameters?: Record<string, { schema?: { example?: string } }> };
};
const specOps = new Map<string, { method: string; path: string }>();
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [verb, op] of Object.entries(item)) {
    if (op && typeof op === 'object' && op.operationId)
      specOps.set(op.operationId, { method: verb.toUpperCase(), path });
  }
}

/**
 * Operations reachable only through `client.request(operationId)` / `typed()`,
 * each with its reason. Empty today; an entry here is a decision, not a gap.
 */
const REQUEST_ONLY = new Map<string, string>([]);

/** Hand-written members that make no API call, and why. */
const NOT_A_ROUTE = new Map<string, string>([
  ['webhooks.verifySignature', 'local HMAC check, no request'],
  ['webhooks.constructEvent', 'local HMAC check + parse, no request'],
]);

type Fn = ((...a: unknown[]) => unknown) & { operationId?: string; positional?: Fn };

function recordingClient() {
  const calls: { method: string; url: string }[] = [];
  const client = new ForumulateClient({
    baseUrl: 'http://api.test',
    maxRetries: 0,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ method: init.method ?? 'GET', url });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch,
  });
  return { client, calls };
}

/** Members of a namespace and its sub-namespaces, by dotted path. */
function walk(client: ForumulateClient): Map<string, Fn> {
  const out = new Map<string, Fn>();
  const names = new Set([...namespaceNames(), 'content']);
  for (const ns of names) {
    const obj = (client as unknown as Record<string, Record<string, unknown>>)[ns]!;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'function') out.set(`${ns}.${k}`, v as Fn);
      else if (v && typeof v === 'object') {
        for (const [m, f] of Object.entries(v))
          if (typeof f === 'function') out.set(`${ns}.${k}.${m}`, f as Fn);
      }
    }
  }
  return out;
}

/** The operation a concrete request hit: the most literal template that matches. */
function matchRoute(method: string, url: string): Route | undefined {
  const path = new URL(url).pathname;
  let best: { route: Route; params: number } | undefined;
  for (const route of routeTable().byId.values()) {
    if (route.method !== method) continue;
    const re = new RegExp(
      '^' +
        route.path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[^}]+\\?\}/g, '[^/]+') +
        '$',
    );
    if (!re.test(path)) continue;
    const params = (route.path.match(/\{/g) ?? []).length;
    if (!best || params < best.params) best = { route, params };
  }
  return best?.route;
}

describe('route table', () => {
  it('is what the committed openapi.json generates', () => {
    expect(() =>
      execFileSync(process.execPath, [join(root, 'scripts/generate-operations.mjs'), '--check']),
    ).not.toThrow();
  });

  it('has every spec operation, with the spec method and path', () => {
    const { byId } = routeTable();
    const missing = [...specOps.keys()].filter((id) => !byId.has(id));
    expect(missing).toEqual([]);
    for (const [id, op] of specOps) {
      const r = byId.get(id)!;
      expect(`${r.method} ${r.path}`, id).toBe(`${op.method} ${op.path}`);
    }
    expect(byId.size).toBe(specOps.size);
  });

  it('names no path parameter after a call option', () => {
    for (const r of routeTable().byId.values()) {
      for (const p of r.path.match(/\{([^}]+)\}/g) ?? []) {
        expect(
          ['query', 'body', 'headers', 'idempotencyKey', 'signal', 'maxRetries'],
          r.id,
        ).not.toContain(p.slice(1, -1));
      }
    }
  });

  it('states the version the spec was generated at', () => {
    expect(API_VERSION).toBe(
      spec.components?.parameters?.ForumulateVersion?.schema?.example ?? '2026-12-01',
    );
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
    expect(SDK_VERSION).toBe(pkg.version);
  });
});

describe('namespaces', () => {
  // A helper sharing a name with a generated method must call the same operation:
  // one member answers both call shapes, so two operations behind it would be a trap.
  it('maps every operationId to a method, or to an explicit request-only entry', async () => {
    const { client, calls } = recordingClient();
    const members = walk(client);
    const reached = new Map<string, string>(); // operationId → first member path
    const unrouted: string[] = [];
    const twoMinds: string[] = [];

    for (const [path, fn] of members) {
      const positional = fn.positional;
      if (fn.operationId && !reached.has(fn.operationId)) reached.set(fn.operationId, path);
      if (fn.operationId && !positional) continue;
      // A hand-written helper (alone, or the 0.5 half of a two-shape member):
      // call it with placeholder arguments and see where it goes.
      const before = calls.length;
      try {
        await (positional ?? fn)('p0', 'p1', 'p2', 'p3', 'p4', 'p5');
      } catch {
        /* a helper that validates its input is fine; what matters is the request */
      }
      const call = calls[before];
      const route = call && matchRoute(call.method, call.url);
      if (positional && route?.id !== fn.operationId) {
        twoMinds.push(
          `${path}: the 0.5 helper calls ${route?.id ?? 'nothing'}, the generated method ${fn.operationId}`,
        );
        continue;
      }
      if (!route) {
        if (!NOT_A_ROUTE.has(path))
          unrouted.push(`${path} → ${call ? `${call.method} ${call.url}` : 'no request'}`);
        continue;
      }
      if (!reached.has(route.id)) reached.set(route.id, path);
    }

    // Every helper's route exists in openapi.json: `auth.register`/`auth.login` called
    // routes the Atlas cutover removed and failed for every caller, unnoticed.
    expect(unrouted, 'hand-written helpers whose route is not in openapi.json').toEqual([]);
    expect(
      twoMinds,
      'one name, two operations — rename the helper or override the placement',
    ).toEqual([]);
    const missing = [...specOps.keys()].filter((id) => !reached.has(id) && !REQUEST_ONLY.has(id));
    expect(missing, 'operations with no namespace method').toEqual([]);
    for (const id of REQUEST_ONLY.keys())
      expect(reached.has(id), `${id} is listed request-only but has a method`).toBe(false);
  });

  it('exposes every generated namespace on the client', () => {
    const { client } = recordingClient();
    for (const n of namespaceNames())
      expect(typeof (client as unknown as Record<string, unknown>)[n], n).toBe('object');
  });

  it('builds a namespace only when it is first touched', () => {
    const { client } = recordingClient();
    const d = Object.getOwnPropertyDescriptor(client, 'events')!;
    expect(typeof d.get).toBe('function');
    void client.events;
    expect(Object.getOwnPropertyDescriptor(client, 'events')!.get).toBeUndefined();
  });
});
