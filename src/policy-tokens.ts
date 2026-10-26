/**
 * The policy gate's tokens, on YOUR server: sign a ticket, verify an
 * acceptance token, offline.
 *
 * The gate hands three kinds of compact HS256 JWT around, all signed with a
 * key of the Legal space's keyring (`pgk_…` id, `pgs_…` secret):
 *
 *   ticket      your server → the browser: "this browser acts for user S, for
 *               event E". You sign it; the widget and the hosted page present
 *               it, so nobody can accept in somebody else's name.
 *   acceptance  Forumulate → your server: "S accepted these exact versions,
 *               shown this way, and is / is not clear to proceed".
 *   receipt     an acceptance with no subject yet (a sign-up form accepted
 *               before the account existed); redeem it with
 *               `client.policies.claim`.
 *
 * The same key signs tickets (you) and acceptance tokens (us), so a verifier
 * MUST check `use`: without that, a ticket — which you hand to the browser —
 * would verify as proof of acceptance. `verifyAcceptanceToken` checks it, and
 * the audience, the issuer, the expiry and (when you pass them) the subject
 * and the space.
 *
 * The format is the one in `packages/shared/src/policy-gate/token.ts`, which
 * signs the real tokens; `policy-tokens.test.ts` signs with that file and
 * verifies with this one, so the two cannot drift apart quietly. It is a plain
 * JWT on purpose: any JWT library in any language verifies it with the secret.
 *
 * WebCrypto only — Node ≥ 20, Bun, Deno, Workers, Auth0 Actions, a browser.
 */
import { base64UrlDecode, equalBytes } from './policy-crypto';

export const POLICY_TOKEN_AUDIENCE = 'forumulate:policy-gate';
/** A ticket may live this long at most; the API refuses a longer one. */
export const POLICY_TICKET_MAX_SECONDS = 3600;

export type PolicyGateEvent = 'sign_up' | 'sign_in';
export type PolicyTokenUse = 'ticket' | 'acceptance' | 'receipt';

/** A key of the space's keyring. `kid` may be empty for a bare secret. */
export interface PolicyGateKey {
  kid: string;
  secret: string;
}

/** One accepted version inside an acceptance token or a receipt. */
export interface PolicyTokenAcceptance {
  /** Policy key (`tos`, `privacy`). */
  k: string;
  /** The version accepted. */
  v: string;
  /** SHA-256 (hex) of exactly the HTML that was shown. */
  h: string;
  /** The presentation it was shown in. */
  p: string;
  /** Whether the reader scrolled to the end. */
  s: boolean;
  /** Unix seconds, on Forumulate's database clock. */
  at: number;
}

export interface PolicyTicketClaims {
  use: 'ticket';
  aud: typeof POLICY_TOKEN_AUDIENCE;
  org: string;
  spc: string;
  sub: string;
  evt: PolicyGateEvent;
  eh?: string;
  app?: string;
  ret?: string;
  st?: string;
  loc?: string;
  iat: number;
  exp: number;
  iss?: string;
}

export interface PolicyAcceptanceClaims {
  use: 'acceptance' | 'receipt';
  aud: typeof POLICY_TOKEN_AUDIENCE;
  iss: 'forumulate';
  org: string;
  spc: string;
  /** Absent on a receipt. */
  sub?: string;
  evt: PolicyGateEvent;
  /** Nothing blocking is left for this subject and event. */
  ok: boolean;
  /** Keys still blocking. */
  pend: string[];
  acc: PolicyTokenAcceptance[];
  ctx?: { ip?: string; ua?: string; loc?: string; app?: string; eh?: string };
  jti: string;
  iat: number;
  exp: number;
}

export type PolicyTokenFailure =
  | 'malformed'
  | 'unsupported_algorithm'
  | 'unknown_key'
  | 'bad_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'wrong_audience'
  | 'wrong_issuer'
  | 'wrong_use'
  | 'wrong_subject'
  | 'wrong_space'
  | 'wrong_org'
  | 'not_satisfied'
  | 'no_keys';

export type VerifiedAcceptance =
  | {
      valid: true;
      claims: PolicyAcceptanceClaims;
      /** The key that signed it. */
      kid: string;
      /** `claims.ok`: nothing blocking is left. */
      satisfied: boolean;
      /** `claims.pend`: the keys still blocking. */
      pending: string[];
    }
  | { valid: false; reason: PolicyTokenFailure };

/** A JSON Web Key Set of symmetric (`kty: "oct"`) keys. */
export interface PolicyJwks {
  keys: { kty: string; kid?: string; k?: string; alg?: string }[];
}

export interface VerifyAcceptanceTokenOptions {
  /**
   * The keyring: `[{ kid, secret }]`, or the env-var form
   * `"pgk_a:pgs_…,pgk_b:pgs_…"`. During a rotation keep both keys here; the
   * token's `kid` picks the right one.
   */
  keys?: readonly PolicyGateKey[] | string;
  /** One bare secret, tried against any `kid`. */
  secret?: string;
  /**
   * A URL serving YOUR keyring as a JWKS of `oct` keys (`k` = base64url of the
   * secret's UTF-8 bytes) — a private endpoint of your own, e.g. in front of a
   * secrets manager. The keys are symmetric, so Forumulate never publishes
   * them; this is for teams that keep secrets out of the environment. Cached
   * for `jwksCacheSeconds` and refetched once on an unknown `kid`.
   */
  jwksUrl?: string;
  /** The same set, already in hand. */
  jwks?: PolicyJwks;
  /** Headers for the `jwksUrl` request (its own authorization). */
  jwksHeaders?: Record<string, string>;
  /** Default 300. */
  jwksCacheSeconds?: number;
  /** Which kinds to accept. Default `'acceptance'`; add `'receipt'` on a sign-up form. */
  use?: 'acceptance' | 'receipt' | readonly ('acceptance' | 'receipt')[];
  /** The token must be for this user (your id for them). */
  subject?: string;
  /** The token must be for this Legal space. */
  spaceId?: string;
  /** The token must be for this organization. */
  orgId?: string;
  /** Refuse a token with blocking policies still pending (`reason: 'not_satisfied'`). */
  requireSatisfied?: boolean;
  /** Unix seconds; defaults to now. */
  now?: number;
  /** Clock skew tolerated either way, seconds. Default 30. */
  leewaySeconds?: number;
  fetch?: typeof fetch;
}

const enc = new TextEncoder();

export async function hmacBytes(key: Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}


/**
 * Parse a keyring from one environment variable: `kid:secret` pairs separated
 * by commas or whitespace (`FORUMULATE_POLICY_GATE_KEYS`). A bare secret is
 * kept with an empty `kid` and tried against every token.
 */
export function parsePolicyGateKeys(value: string | undefined | null): PolicyGateKey[] {
  return (value ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((entry) => {
      const i = entry.indexOf(':');
      return i > 0 && entry.startsWith('pgk_')
        ? { kid: entry.slice(0, i), secret: entry.slice(i + 1) }
        : { kid: '', secret: entry };
    });
}

/** SHA-256 hex of a string's UTF-8 bytes (the content hash). */
export async function policySha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
  let out = '';
  for (const b of digest) out += b.toString(16).padStart(2, '0');
  return out;
}

/** How an email becomes `emailHash`: trimmed, lower-cased, SHA-256 hex. */
export function policyEmailHash(email: string): Promise<string> {
  return policySha256Hex(email.trim().toLowerCase());
}

/** Header and claims, UNVERIFIED — for logs and for picking a key. Never for decisions. */
export function decodePolicyToken(
  token: string,
): { header: { alg?: string; kid?: string; typ?: string }; claims: Record<string, unknown> } | null {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  try {
    const dec = new TextDecoder();
    const header = JSON.parse(dec.decode(base64UrlDecode(parts[0]!)));
    const claims = JSON.parse(dec.decode(base64UrlDecode(parts[1]!)));
    if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object') return null;
    return { header, claims };
  } catch {
    return null;
  }
}

interface RingKey {
  kid: string;
  bytes: Uint8Array;
}

const jwksCache = new Map<string, { at: number; keys: RingKey[] }>();

function ringFromJwks(set: PolicyJwks | null | undefined): RingKey[] {
  const out: RingKey[] = [];
  for (const k of set?.keys ?? []) {
    if (k.kty !== 'oct' || typeof k.k !== 'string') continue;
    if (k.alg && k.alg !== 'HS256') continue;
    try {
      out.push({ kid: k.kid ?? '', bytes: base64UrlDecode(k.k) });
    } catch {
      /* a malformed entry is skipped, not fatal: the others may still verify */
    }
  }
  return out;
}

async function loadJwks(opts: PolicyKeyOptions, force: boolean): Promise<RingKey[]> {
  const url = opts.jwksUrl!;
  const ttl = (opts.jwksCacheSeconds ?? 300) * 1000;
  const hit = jwksCache.get(url);
  if (hit && !force && Date.now() - hit.at < ttl) return hit.keys;
  const f = opts.fetch ?? globalThis.fetch;
  const res = await f(url, { headers: { accept: 'application/json', ...(opts.jwksHeaders ?? {}) } });
  if (!res.ok) throw new Error(`Could not load the policy gate keys from ${url}: HTTP ${res.status}`);
  const keys = ringFromJwks((await res.json()) as PolicyJwks);
  jwksCache.set(url, { at: Date.now(), keys });
  return keys;
}

function staticRing(opts: PolicyKeyOptions): RingKey[] {
  const ring: RingKey[] = [];
  const list = typeof opts.keys === 'string' ? parsePolicyGateKeys(opts.keys) : (opts.keys ?? []);
  for (const k of list) if (k.secret) ring.push({ kid: k.kid ?? '', bytes: enc.encode(k.secret) });
  if (opts.secret) ring.push({ kid: '', bytes: enc.encode(opts.secret) });
  ring.push(...ringFromJwks(opts.jwks));
  return ring;
}

/** The key(s) to try: the one named by `kid`, else every id-less key. */
function candidates(ring: RingKey[], kid: string | undefined): RingKey[] {
  const named = ring.filter((k) => k.kid && k.kid === kid);
  return named.length ? named : ring.filter((k) => !k.kid);
}

/**
 * Verify an acceptance token (or receipt) OFFLINE, against your copy of the
 * space's keyring. Returns a result rather than throwing, so the reason is in
 * hand for a log line:
 *
 * ```ts
 * const r = await verifyAcceptanceToken(token, {
 *   keys: process.env.FORUMULATE_POLICY_GATE_KEYS,
 *   subject: user.id,
 *   spaceId: process.env.FORUMULATE_LEGAL_SPACE,
 *   requireSatisfied: true,
 * });
 * if (!r.valid) return res.status(403).send(r.reason);
 * ```
 *
 * Online verification (no key on your server) is `client.policies.verify`.
 */
export async function verifyAcceptanceToken(
  token: string,
  opts: VerifyAcceptanceTokenOptions,
): Promise<VerifiedAcceptance> {
  const signed = await verifySignature(token, opts);
  if (!signed.ok) return { valid: false, reason: signed.reason };
  const c = signed.claims as unknown as PolicyAcceptanceClaims;
  const uses: readonly string[] =
    opts.use === undefined ? ['acceptance'] : typeof opts.use === 'string' ? [opts.use] : opts.use;
  // A ticket is signed with the same key; checking `use` is what keeps one
  // from passing as proof of acceptance.
  const failed = checkClaims(c, uses, opts);
  if (failed) return { valid: false, reason: failed };
  if (c.iss !== 'forumulate') return { valid: false, reason: 'wrong_issuer' };
  const pending = Array.isArray(c.pend) ? c.pend : [];
  const satisfied = c.ok === true;
  if (opts.requireSatisfied && !satisfied) return { valid: false, reason: 'not_satisfied' };
  return { valid: true, claims: c, kid: signed.kid, satisfied, pending };
}

/** Key options shared by every verifier. */
export type PolicyKeyOptions = Pick<
  VerifyAcceptanceTokenOptions,
  'keys' | 'secret' | 'jwks' | 'jwksUrl' | 'jwksHeaders' | 'jwksCacheSeconds' | 'fetch'
>;

/**
 * Verify a TICKET (yours, signed with the same keyring), for a server that
 * receives one back: a bridge between an auth platform's redirect and the
 * hosted page, say. A ticket meant to live longer than an hour is refused.
 */
export async function verifyPolicyTicket(
  token: string,
  opts: PolicyKeyOptions & {
    subject?: string;
    spaceId?: string;
    orgId?: string;
    now?: number;
    leewaySeconds?: number;
  },
): Promise<
  { valid: true; claims: PolicyTicketClaims; kid: string } | { valid: false; reason: PolicyTokenFailure }
> {
  const signed = await verifySignature(token, opts);
  if (!signed.ok) return { valid: false, reason: signed.reason };
  const c = signed.claims as unknown as PolicyTicketClaims;
  const failed = checkClaims(c, ['ticket'], opts);
  if (failed) return { valid: false, reason: failed };
  if (typeof c.iat !== 'number' || c.exp - c.iat > POLICY_TICKET_MAX_SECONDS)
    return { valid: false, reason: 'expired' };
  return { valid: true, claims: c, kid: signed.kid };
}

/** The checks every kind shares: audience, use, time, and the ids you pinned. */
function checkClaims(
  c: { aud?: unknown; use?: unknown; exp?: unknown; iat?: unknown; sub?: unknown; spc?: unknown; org?: unknown },
  uses: readonly string[],
  opts: { subject?: string; spaceId?: string; orgId?: string; now?: number; leewaySeconds?: number },
): PolicyTokenFailure | null {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const leeway = opts.leewaySeconds ?? 30;
  if (c.aud !== POLICY_TOKEN_AUDIENCE) return 'wrong_audience';
  if (typeof c.use !== 'string' || !uses.includes(c.use)) return 'wrong_use';
  if (typeof c.exp !== 'number' || c.exp + leeway < now) return 'expired';
  if (typeof c.iat === 'number' && c.iat - leeway > now) return 'not_yet_valid';
  if (opts.subject !== undefined && c.sub !== opts.subject) return 'wrong_subject';
  if (opts.spaceId !== undefined && c.spc !== opts.spaceId) return 'wrong_space';
  if (opts.orgId !== undefined && c.org !== opts.orgId) return 'wrong_org';
  return null;
}

/** The signature half: HS256 only, the key picked by `kid`, compared in constant time. */
async function verifySignature(
  token: string,
  opts: PolicyKeyOptions,
): Promise<{ ok: true; claims: Record<string, unknown>; kid: string } | { ok: false; reason: PolicyTokenFailure }> {
  const parts = String(token ?? '').split('.');
  const decoded = parts.length === 3 ? decodePolicyToken(token) : null;
  if (!decoded) return { ok: false, reason: 'malformed' };
  // `alg` is read from the token only to REFUSE anything but HS256, never to
  // choose an algorithm: that is the classic `alg: none` hole.
  if (decoded.header.alg !== 'HS256') return { ok: false, reason: 'unsupported_algorithm' };
  let sig: Uint8Array;
  try {
    sig = base64UrlDecode(parts[2]!);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  let ring = staticRing(opts);
  if (opts.jwksUrl) ring = ring.concat(await loadJwks(opts, false));
  if (!ring.length) return { ok: false, reason: 'no_keys' };
  let keys = candidates(ring, decoded.header.kid);
  if (!keys.length && opts.jwksUrl) {
    // A kid we have not seen: the keyring was rotated since the cache filled.
    ring = staticRing(opts).concat(await loadJwks(opts, true));
    keys = candidates(ring, decoded.header.kid);
  }
  if (!keys.length) return { ok: false, reason: 'unknown_key' };

  for (const key of keys) {
    if (equalBytes(await hmacBytes(key.bytes, `${parts[0]}.${parts[1]}`), sig)) {
      return { ok: true, claims: decoded.claims, kid: key.kid };
    }
  }
  return { ok: false, reason: 'bad_signature' };
}
