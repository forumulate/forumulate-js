/**
 * Tickets and the hosted page round trip: the half of the policy gate your
 * server SIGNS. See `./policy-tokens` for the format and the verifiers.
 */
import { base64UrlEncode } from './policy-crypto';
import {
  POLICY_TICKET_MAX_SECONDS,
  POLICY_TOKEN_AUDIENCE,
  hmacBytes,
  parsePolicyGateKeys,
  policyEmailHash,
  type PolicyGateEvent,
  type PolicyGateKey,
  type PolicyTicketClaims,
} from './policy-tokens';

const enc = new TextEncoder();

export interface PolicyTicketInput {
  orgId: string;
  /** The Legal space. */
  spaceId: string;
  /** Your id for the user. Opaque to Forumulate; up to 200 characters. */
  subject: string;
  event: PolicyGateEvent;
  /** Hashed here, before it leaves your server; never sent in clear. */
  email?: string;
  /** The email's hash instead (`policyEmailHash`), e.g. from a ticket you verified. */
  emailHash?: string;
  /** Your name for the app (`web`, `ios`), recorded as `sourceApp`. */
  sourceApp?: string;
  /** Hosted page only: where to send the reader back. Must match the space's `page.returnUrls`. */
  returnUrl?: string;
  /** Hosted page only: echoed back verbatim, like OAuth `state`. */
  state?: string;
  locale?: string;
  /** 30–3600 seconds. Default 600. */
  ttlSeconds?: number;
  /** Unix seconds; defaults to now. */
  now?: number;
}

/**
 * Sign a ticket with a key of the space's keyring — no call to Forumulate.
 * Hand it to the widget (`ticket` attribute / prop) or put it on the hosted
 * page's URL with {@link policyGatePageUrl}.
 */
export async function signPolicyTicket(
  input: PolicyTicketInput,
  key: PolicyGateKey | string,
): Promise<string> {
  const k = typeof key === 'string' ? (parsePolicyGateKeys(key)[0] ?? null) : key;
  if (!k?.secret) throw new TypeError('signPolicyTicket needs a key: { kid, secret } or "pgk_…:pgs_…"');
  const ttl = Math.min(Math.max(Math.floor(input.ttlSeconds ?? 600), 30), POLICY_TICKET_MAX_SECONDS);
  const iat = input.now ?? Math.floor(Date.now() / 1000);
  const claims: PolicyTicketClaims = {
    use: 'ticket',
    aud: POLICY_TOKEN_AUDIENCE,
    org: input.orgId,
    spc: input.spaceId,
    sub: input.subject,
    evt: input.event,
    iat,
    exp: iat + ttl,
  };
  if (input.email) claims.eh = await policyEmailHash(input.email);
  else if (input.emailHash) claims.eh = input.emailHash;
  if (input.sourceApp) claims.app = input.sourceApp;
  if (input.returnUrl) claims.ret = input.returnUrl;
  if (input.state) claims.st = input.state;
  if (input.locale) claims.loc = input.locale;
  const head = base64UrlEncode(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: k.kid })));
  const body = base64UrlEncode(enc.encode(JSON.stringify(claims)));
  const sig = await hmacBytes(enc.encode(k.secret), `${head}.${body}`);
  return `${head}.${body}.${base64UrlEncode(sig)}`;
}

/**
 * The hosted acceptance page for a ticket that carries a `returnUrl`:
 * `https://forumulate.com/policy/{orgId}/{spaceId}?ticket=…`. Redirect the
 * user there; they come back to `returnUrl` with `policy_token` (or
 * `policy_error`) and your `state` — read it with {@link readPolicyReturn}.
 */
export function policyGatePageUrl(input: {
  orgId: string;
  spaceId: string;
  ticket: string;
  /** The site the page is served from. Default `https://forumulate.com`. */
  site?: string;
}): string {
  const site = (input.site ?? 'https://forumulate.com').replace(/\/+$/, '');
  const e = encodeURIComponent;
  return `${site}/policy/${e(input.orgId)}/${e(input.spaceId)}?ticket=${e(input.ticket)}`;
}

export interface PolicyReturn {
  /** The acceptance token, when the user accepted (or there was nothing to accept). */
  token: string | null;
  tokenType: 'acceptance' | 'receipt' | null;
  /** `declined` when a blocking policy was declined. */
  error: string | null;
  /** Your `state`, verbatim. Compare it with what you stored before redirecting. */
  state: string | null;
}

/** Read the query the hosted page appended to your return URL. Verify `token` before trusting it. */
export function readPolicyReturn(url: string | URL | URLSearchParams): PolicyReturn {
  const q =
    url instanceof URLSearchParams
      ? url
      : new URL(String(url), 'https://return.invalid').searchParams;
  const type = q.get('policy_token_type');
  return {
    token: q.get('policy_token'),
    tokenType: type === 'acceptance' || type === 'receipt' ? type : null,
    error: q.get('policy_error'),
    state: q.get('state'),
  };
}
