/**
 * Verifying a webhook delivery, as the receiver actually has to do it.
 *
 * The published contract said:
 *
 *     X-Forumulate-Signature: v1,sha256=<hex>
 *
 * and a reader does the obvious thing with that — compute one value and
 * compare the header to it. Every delivery to an endpoint still on the default
 * `signatureVersion: 'both'`, and every delivery during a secret rotation,
 * then fails to verify, because the real header is a comma-separated LIST:
 *
 *     v1,sha256=<a>, v1,sha256=<b>, sha256=<c>, sha256=<d>
 *       ^ current secret, v1    ^ previous secret, v1
 *                               ^ the legacy body-only signature, both secrets
 *
 * The sender was right and the document was wrong. Two secrets ride along
 * through a rotation so nobody's verifier breaks on a day we choose, and the
 * legacy body-only signature rides along until the endpoint's owner turns it
 * off — and a receiver is meant to accept the delivery if ANY entry matches
 * the one it computes. That is three facts a sentence in a reference page kept
 * getting wrong, so here is the function instead.
 *
 * Verify `v1`. It signs `<timestamp>.<raw body>`, which is what makes a
 * captured delivery un-replayable: the legacy `sha256=` covers the body alone
 * and is therefore replayable forever. This accepts only `v1` unless you ask
 * for the legacy one explicitly.
 *
 *     import { verifyWebhookSignature } from '@forumulate/sdk';
 *
 *     app.post('/hooks/forumulate', async (req, res) => {
 *       const ok = await verifyWebhookSignature({
 *         secret: process.env.FORUMULATE_WEBHOOK_SECRET!,
 *         // The RAW body, before any JSON parsing. A re-serialised body has
 *         // different bytes and will never verify.
 *         body: req.rawBody,
 *         signature: req.header('X-Forumulate-Signature'),
 *         timestamp: req.header('X-Forumulate-Timestamp'),
 *       });
 *       if (!ok) return res.sendStatus(401);
 *       // X-Forumulate-Delivery is the key to dedupe on — retries reuse it.
 *       res.sendStatus(200);
 *     });
 *
 * WebCrypto, so this is the same code in Node, Bun, Deno, Cloudflare Workers
 * and a browser. It is async for that reason alone.
 */
export interface VerifyWebhookInput {
  /** The endpoint's signing secret. */
  secret: string;
  /** The raw request body, exactly as received — bytes, or the string of them. */
  body: string | Uint8Array;
  /** The `X-Forumulate-Signature` header value, whole. */
  signature: string | null | undefined;
  /** The `X-Forumulate-Timestamp` header value (unix seconds). */
  timestamp: string | number | null | undefined;
  /**
   * How old a delivery may be, in seconds. Default 300.
   *
   * This is the part that makes the timestamp worth signing: without a window,
   * a captured delivery verifies forever and the signature proves only that we
   * sent it ONCE. Set it to 0 to skip the check (for a replay of a stored
   * delivery in a test, say).
   */
  toleranceSeconds?: number;
  /**
   * Accept the legacy body-only `sha256=` signature as well. Default false.
   *
   * It is still sent while an endpoint's `signatureVersion` is `both`, and it
   * is replayable by construction, so accepting it is a decision rather than a
   * default.
   */
  acceptLegacy?: boolean;
  /** Overridable for tests. Defaults to now. */
  now?: () => number;
}

export async function verifyWebhookSignature(input: VerifyWebhookInput): Promise<boolean> {
  const { secret, signature, acceptLegacy = false, toleranceSeconds = 300 } = input;
  if (!secret || !signature) return false;

  const timestamp = Number(input.timestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return false;
  if (toleranceSeconds > 0) {
    const now = Math.floor((input.now?.() ?? Date.now()) / 1000);
    // Both directions: a delivery from the future is as suspicious as a stale
    // one, and clock skew is why the window is seconds rather than exact.
    if (Math.abs(now - timestamp) > toleranceSeconds) return false;
  }

  const body = typeof input.body === 'string' ? input.body : new TextDecoder().decode(input.body);
  // Entries, not an equality check: a rotation and the legacy overlap both put
  // more than one signature in this header, and `header === expected` is the
  // mistake the document invited.
  const offered = signature.split(',').map((part) => part.trim().toLowerCase());
  const expected = [`v1,sha256=${await hmacHex(secret, `${timestamp}.${body}`)}`];
  if (acceptLegacy) expected.push(`sha256=${await hmacHex(secret, body)}`);

  for (const candidate of expected) {
    // `v1,sha256=<hex>` contains the comma we just split on, so put it back.
    const [prefix, value] = candidate.split('=', 2) as [string, string];
    const wanted = `${prefix}=${value}`;
    const rejoined = offered.join(',');
    // Membership against the rejoined list rather than the split parts, so the
    // `v1,` prefix survives the split that produced the parts.
    if (!rejoined.includes(wanted)) continue;
    if (timingSafeEqual(wanted, extractMatch(rejoined, wanted))) return true;
  }
  return false;
}

/** The substring of `haystack` at `needle`'s position, for a constant-time compare. */
function extractMatch(haystack: string, needle: string): string {
  const at = haystack.indexOf(needle);
  return at < 0 ? '' : haystack.slice(at, at + needle.length);
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Length-independent, content-constant-time comparison.
 *
 * Both sides here are hex of a fixed length, so this is belt and braces — but
 * a verifier is exactly the place where "it does not matter here" ages badly.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
