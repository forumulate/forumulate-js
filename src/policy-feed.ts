/**
 * Forumulate policy feed v1, both directions — so any platform can CONSUME a
 * Legal space's policies, or IMPLEMENT the same protocol itself.
 *
 *   feed request   consumer → source. `GET …/policies`, signed with three
 *                  headers, `forumulate-id`, `forumulate-timestamp` (Unix
 *                  MILLISECONDS) and `forumulate-signature`, or the same three
 *                  as `atlas-*` (Atlas's spelling; the source takes both).
 *                  Signature: `v1,` + base64(HMAC-SHA256(key,
 *                  "{id}.{timestamp}.GET\n{path}")), `{path}` being the path
 *                  plus query exactly as requested — with `/api` on
 *                  forumulate.com. Several space-separated `v1,` values during
 *                  a rotation; any one matching is enough.
 *   webhook        source → consumer. Standard Webhooks: `webhook-id`,
 *                  `webhook-timestamp` (Unix SECONDS), `webhook-signature:
 *                  v1,<base64 HMAC-SHA256(key, "{id}.{timestamp}.{body}")>`.
 *                  Bodies: `policy.published` {key, version} and
 *                  `policy.retired` {key}. A webhook carries no policy text on
 *                  purpose: the consumer fetches the feed for that.
 *
 * THE KEY. A secret is `whsec_` + base64 of 32 random bytes (the Standard
 * Webhooks spelling), and the HMAC key is the DECODED bytes. A secret without
 * that prefix is used as its own UTF-8 bytes. The source also accepts a feed
 * request signed with a `whsec_` secret's raw UTF-8 bytes, because which of
 * the two an HMAC call gets is the commonest mistake; the verifier below does
 * the same, the signer always uses the decoded key.
 *
 * The server half lives in `packages/shared/src/policy-feed` (node:crypto);
 * `policy-feed.test.ts` checks this file against it. WebCrypto here.
 */
import { equalBytes } from './policy-crypto';

const enc = new TextEncoder();
const SECRET_PREFIX = 'whsec_';
/** Five minutes, both for the feed's millisecond clock and the webhook's seconds. */
const DEFAULT_TOLERANCE_SECONDS = 300;

/** One version in the feed. Field names are the protocol's (snake_case). */
export interface PolicyFeedVersion {
  version: string;
  published_at: string;
  effective_at: string;
  content_html?: string;
  content_markdown?: string;
  /** Public URL of exactly this version; it never changes. */
  content_url: string;
  /** SHA-256 hex of `content_html`, so a consumer can check what it stored. */
  content_sha256?: string;
  summary_of_changes?: string;
  locale?: string;
}

export interface PolicyFeedPolicy {
  key: string;
  title: string;
  display: 'checkbox' | 'scroll' | 'link';
  required: boolean;
  applies_to: 'sign_up' | 'sign_in_and_sign_up';
  /** `never`, `next_sign_in` or `grace_days:N`. */
  reaccept?: string;
  versions: PolicyFeedVersion[];
}

export interface PolicyFeedList {
  object: 'policy_list';
  policies: PolicyFeedPolicy[];
}

export type PolicyWebhookEvent =
  | { type: 'policy.published'; key: string; version: string; occurred_at: string }
  | { type: 'policy.retired'; key: string; occurred_at: string };

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function base64ToBytes(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** The HMAC key a secret stands for: the decoded bytes of a `whsec_` secret, else its UTF-8. */
export function policySecretKey(secret: string): Uint8Array {
  if (secret.startsWith(SECRET_PREFIX)) {
    const raw = base64ToBytes(secret.slice(SECRET_PREFIX.length));
    if (raw && raw.length > 0) return raw;
  }
  return enc.encode(secret);
}

async function hmacBase64(key: Uint8Array, data: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return bytesToBase64(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data))));
}

/** The `v1,` values of a signature header (space separated), at most eight. */
function signatureValues(header: string | null | undefined): string[] {
  return String(header ?? '')
    .split(/\s+/)
    .filter((v) => v.startsWith('v1,'))
    .map((v) => v.slice(3))
    .filter(Boolean)
    .slice(0, 8);
}

function sameString(a: string, b: string): boolean {
  return equalBytes(enc.encode(a), enc.encode(b));
}

/** Headers as a Fetch `Headers`, a Node `IncomingHttpHeaders` or a plain record. */
export type HeaderBag =
  | Headers
  | Record<string, string | string[] | undefined | null>
  | { get(name: string): string | null };

function headerOf(headers: HeaderBag, name: string): string | null {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get(n: string): string | null }).get(name);
  }
  const rec = headers as Record<string, string | string[] | undefined | null>;
  const hit = Object.keys(rec).find((k) => k.toLowerCase() === name);
  const v = hit === undefined ? undefined : rec[hit];
  return Array.isArray(v) ? v.join(' ') : (v ?? null);
}

function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? `req_${c.randomUUID()}` : `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

/* ------------------------------------------------------------------ *
 * Feed requests
 * ------------------------------------------------------------------ */

/** The exact string a feed request signs. */
export function policyFeedSigningString(id: string, timestamp: string, path: string): string {
  return `${id}.${timestamp}.GET\n${path}`;
}

export interface SignPolicyFeedRequestInput {
  /** The link's shared secret (`whsec_…`). During a rotation, pass both: every one signs. */
  secret: string | readonly string[];
  /** Path plus query as you will request it, e.g. `/api/policy-feed/spaces/sp_1/policies?key=tos`. */
  path: string;
  /** Unique per request; the source refuses a repeat within five minutes. Default: random. */
  id?: string;
  /** Unix milliseconds. Default: now. */
  timestamp?: number;
  /** `forumulate` (default) or `atlas`, for the header names. */
  prefix?: 'forumulate' | 'atlas';
}

/**
 * The three headers that sign one feed request. Use a fresh call per request:
 * the id is single-use, so a retry must be signed again.
 *
 * ```ts
 * const path = `/api/policy-feed/spaces/${spaceId}/policies`;
 * const headers = await signPolicyFeedRequest({ secret: process.env.POLICY_FEED_SECRET!, path });
 * const list = await (await fetch(`https://forumulate.com${path}`, { headers })).json();
 * ```
 */
export async function signPolicyFeedRequest(
  input: SignPolicyFeedRequestInput,
): Promise<Record<string, string>> {
  const p = input.prefix ?? 'forumulate';
  const id = input.id ?? randomId();
  const ts = String(Math.floor(input.timestamp ?? Date.now()));
  const secrets = typeof input.secret === 'string' ? [input.secret] : input.secret;
  if (!secrets.length || secrets.some((s) => !s)) throw new TypeError('signPolicyFeedRequest needs a secret');
  const data = policyFeedSigningString(id, ts, input.path);
  const sigs = await Promise.all(secrets.map(async (s) => `v1,${await hmacBase64(policySecretKey(s), data)}`));
  return { [`${p}-id`]: id, [`${p}-timestamp`]: ts, [`${p}-signature`]: sigs.join(' ') };
}

export type PolicyFeedRequestFailure =
  | 'missing_headers'
  | 'stale_timestamp'
  | 'bad_signature'
  | 'replayed';

export interface VerifyPolicyFeedRequestInput {
  /** Every secret still valid for the link: the current one and, for 24 h after a rotation, the previous. */
  secrets: string | readonly string[];
  headers: HeaderBag;
  /**
   * The path plus query the CONSUMER requested. Pass several when a proxy in
   * front of you rewrites it (`/api/…` outside, `/…` inside): any one matching
   * is enough.
   */
  path: string | readonly string[];
  /** Milliseconds of clock difference allowed. Default 300 000 (five minutes). */
  toleranceMs?: number;
  /**
   * Replay protection: return `true` if this id was already seen in the last
   * five minutes (and remember it). Without it, a captured request can be
   * replayed inside the window — fine for a read-only feed, but say so.
   */
  seen?: (id: string) => boolean | Promise<boolean>;
  /** Unix milliseconds; defaults to now. */
  now?: number;
}

/**
 * Check a signed feed request — the half a policy SOURCE implements. Either
 * header spelling (`forumulate-*` or `atlas-*`) is read.
 */
export async function verifyPolicyFeedRequest(
  input: VerifyPolicyFeedRequestInput,
): Promise<{ valid: true; id: string } | { valid: false; reason: PolicyFeedRequestFailure }> {
  let id: string | null = null;
  let ts: string | null = null;
  let sig: string | null = null;
  for (const p of ['forumulate', 'atlas']) {
    id = headerOf(input.headers, `${p}-id`);
    ts = headerOf(input.headers, `${p}-timestamp`);
    sig = headerOf(input.headers, `${p}-signature`);
    if (id && ts && sig) break;
  }
  if (!id || !ts || !sig) return { valid: false, reason: 'missing_headers' };
  const now = input.now ?? Date.now();
  // Digits only: `1e12`, hex or a float is refused rather than coerced.
  if (!/^\d{1,16}$/.test(ts) || Math.abs(Number(ts) - now) > (input.toleranceMs ?? DEFAULT_TOLERANCE_SECONDS * 1000))
    return { valid: false, reason: 'stale_timestamp' };

  const presented = signatureValues(sig);
  const secrets = typeof input.secrets === 'string' ? [input.secrets] : input.secrets;
  const paths = typeof input.path === 'string' ? [input.path] : input.path;
  let ok = false;
  // Every candidate is tried, so the time taken does not say which matched.
  for (const secret of secrets) {
    if (!secret) continue;
    for (const key of [policySecretKey(secret), enc.encode(secret)]) {
      for (const path of paths) {
        const expected = await hmacBase64(key, policyFeedSigningString(id, ts, path));
        for (const s of presented) if (sameString(s, expected)) ok = true;
      }
    }
  }
  if (!ok) return { valid: false, reason: 'bad_signature' };
  // Checked AFTER the signature, so an unsigned flood cannot fill the replay store.
  if (input.seen && (await input.seen(id))) return { valid: false, reason: 'replayed' };
  return { valid: true, id };
}

/* ------------------------------------------------------------------ *
 * Webhooks
 * ------------------------------------------------------------------ */

export class PolicyWebhookError extends Error {
  constructor(
    readonly reason: 'missing_headers' | 'stale_timestamp' | 'bad_signature' | 'bad_body',
    message: string,
  ) {
    super(message);
    this.name = 'PolicyWebhookError';
  }
}

export interface VerifyPolicyWebhookOptions {
  /** Seconds a delivery may be old (or early). Default 300; 0 skips the check. */
  toleranceSeconds?: number;
  /** Unix milliseconds; defaults to now. */
  now?: number;
}

/**
 * Verify a `policy.published` / `policy.retired` notice and parse it. Throws
 * {@link PolicyWebhookError} — the parse can never run ahead of the check.
 *
 * `body` must be the RAW request body: a re-serialised object has different
 * bytes and never verifies. During a secret rotation pass both secrets.
 * Dedupe on `webhook-id`: a retry of one event reuses it.
 *
 * ```ts
 * const event = await verifyPolicyWebhook(req.headers, rawBody, process.env.POLICY_FEED_SECRET!);
 * if (event.type === 'policy.published') await refreshPolicies(event.key);
 * ```
 */
export async function verifyPolicyWebhook(
  headers: HeaderBag,
  body: string | Uint8Array,
  secret: string | readonly string[],
  opts: VerifyPolicyWebhookOptions = {},
): Promise<PolicyWebhookEvent> {
  const id = headerOf(headers, 'webhook-id');
  const ts = headerOf(headers, 'webhook-timestamp');
  const sig = headerOf(headers, 'webhook-signature');
  if (!id || !ts || !sig) {
    throw new PolicyWebhookError('missing_headers', 'webhook-id, webhook-timestamp and webhook-signature are required');
  }
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (!/^\d{1,12}$/.test(ts)) throw new PolicyWebhookError('stale_timestamp', 'webhook-timestamp is not Unix seconds');
  if (tolerance > 0) {
    const now = Math.floor((opts.now ?? Date.now()) / 1000);
    if (Math.abs(now - Number(ts)) > tolerance) {
      throw new PolicyWebhookError('stale_timestamp', 'webhook-timestamp is outside the tolerance window');
    }
  }
  const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
  const presented = signatureValues(sig);
  const secrets = typeof secret === 'string' ? [secret] : secret;
  let ok = false;
  for (const s of secrets) {
    if (!s) continue;
    const expected = await hmacBase64(policySecretKey(s), `${id}.${ts}.${text}`);
    for (const p of presented) if (sameString(p, expected)) ok = true;
  }
  if (!ok) throw new PolicyWebhookError('bad_signature', 'Policy webhook signature did not verify (wrong secret or altered body)');
  let event: PolicyWebhookEvent;
  try {
    event = JSON.parse(text) as PolicyWebhookEvent;
  } catch {
    throw new PolicyWebhookError('bad_body', 'Policy webhook body is not JSON');
  }
  if (!event || (event.type !== 'policy.published' && event.type !== 'policy.retired') || typeof event.key !== 'string') {
    throw new PolicyWebhookError('bad_body', 'Not a policy.published or policy.retired notice');
  }
  return event;
}

/** Standard Webhooks headers for one notice — the SENDING half, for a platform implementing the protocol. */
export async function signPolicyWebhook(input: {
  secret: string | readonly string[];
  body: string;
  id?: string;
  /** Unix seconds. Default: now. */
  timestamp?: number;
}): Promise<{ 'webhook-id': string; 'webhook-timestamp': string; 'webhook-signature': string }> {
  const id = input.id ?? `msg_${randomId().slice(4)}`;
  const ts = String(Math.floor(input.timestamp ?? Date.now() / 1000));
  const secrets = typeof input.secret === 'string' ? [input.secret] : input.secret;
  const sigs = await Promise.all(
    secrets.map(async (s) => `v1,${await hmacBase64(policySecretKey(s), `${id}.${ts}.${input.body}`)}`),
  );
  return { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': sigs.join(' ') };
}
