import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyWebhookSignature } from './webhooks';

/**
 * The header a delivery really carries, built the way the worker builds it.
 *
 * `signatureHeader()` in apps/worker/src/webhook.processor.ts: every live
 * secret signed `v1`, and — while the endpoint's `signatureVersion` is `both`
 * — every live secret signed the legacy body-only way as well, all of it in
 * one comma-separated header value. The document described ONE signature, so a
 * reader wrote `header === expected` and every delivery failed to verify.
 */
function header(
  secrets: string[],
  timestamp: number,
  body: string,
  version: 'both' | 'v1' = 'both',
): string {
  const v1 = secrets.map(
    (s) => `v1,sha256=${createHmac('sha256', s).update(`${timestamp}.${body}`).digest('hex')}`,
  );
  const legacy = secrets.map((s) => `sha256=${createHmac('sha256', s).update(body).digest('hex')}`);
  return version === 'v1' ? v1.join(', ') : [...v1, ...legacy].join(', ');
}

const BODY = '{"event":"page.published","data":{"id":"p1"}}';
const TS = 1_780_000_000;
const now = () => TS * 1000;

describe('verifyWebhookSignature', () => {
  it('verifies a delivery from an endpoint on `v1` only', async () => {
    const ok = await verifyWebhookSignature({
      secret: 'whsec_live',
      body: BODY,
      signature: header(['whsec_live'], TS, BODY, 'v1'),
      timestamp: TS,
      now,
    });
    expect(ok).toBe(true);
  });

  it('verifies a delivery that also carries the legacy signature', async () => {
    // The default. A verifier written from the old one-signature sentence
    // failed on every one of these.
    const ok = await verifyWebhookSignature({
      secret: 'whsec_live',
      body: BODY,
      signature: header(['whsec_live'], TS, BODY, 'both'),
      timestamp: TS,
      now,
    });
    expect(ok).toBe(true);
  });

  it('verifies with either secret during a rotation', async () => {
    const value = header(['whsec_new', 'whsec_old'], TS, BODY);
    for (const secret of ['whsec_new', 'whsec_old']) {
      expect(
        await verifyWebhookSignature({ secret, body: BODY, signature: value, timestamp: TS, now }),
        secret,
      ).toBe(true);
    }
  });

  it('refuses a secret that signed none of the entries', async () => {
    const ok = await verifyWebhookSignature({
      secret: 'whsec_someone_else',
      body: BODY,
      signature: header(['whsec_live'], TS, BODY),
      timestamp: TS,
      now,
    });
    expect(ok).toBe(false);
  });

  it('refuses a body that was changed in flight', async () => {
    const ok = await verifyWebhookSignature({
      secret: 'whsec_live',
      body: BODY.replace('p1', 'p2'),
      signature: header(['whsec_live'], TS, BODY),
      timestamp: TS,
      now,
    });
    expect(ok).toBe(false);
  });

  it('refuses a stale delivery, which is the whole reason the timestamp is signed', async () => {
    const value = header(['whsec_live'], TS, BODY);
    const later = () => (TS + 3600) * 1000;
    expect(
      await verifyWebhookSignature({
        secret: 'whsec_live',
        body: BODY,
        signature: value,
        timestamp: TS,
        now: later,
      }),
    ).toBe(false);
    // …and accepts it when the caller says replay protection is not wanted.
    expect(
      await verifyWebhookSignature({
        secret: 'whsec_live',
        body: BODY,
        signature: value,
        timestamp: TS,
        toleranceSeconds: 0,
        now: later,
      }),
    ).toBe(true);
  });

  it('refuses a delivery from the future, which is as suspicious as a stale one', async () => {
    const future = TS + 3600;
    const ok = await verifyWebhookSignature({
      secret: 'whsec_live',
      body: BODY,
      signature: header(['whsec_live'], future, BODY),
      timestamp: future,
      now,
    });
    expect(ok).toBe(false);
  });

  it('refuses a signature whose timestamp does not match the one it was signed with', async () => {
    // Swapping the header's timestamp for a fresh one is the replay a `v1`
    // signature exists to stop.
    const ok = await verifyWebhookSignature({
      secret: 'whsec_live',
      body: BODY,
      signature: header(['whsec_live'], TS - 10, BODY, 'v1'),
      timestamp: TS,
      now,
    });
    expect(ok).toBe(false);
  });

  it('does not accept the legacy body-only signature unless asked', async () => {
    // It is replayable by construction, so accepting it is a decision.
    const legacy = `sha256=${createHmac('sha256', 'whsec_live').update(BODY).digest('hex')}`;
    const args = {
      secret: 'whsec_live',
      body: BODY,
      signature: legacy,
      timestamp: TS,
      now,
    } as const;
    expect(await verifyWebhookSignature(args)).toBe(false);
    expect(await verifyWebhookSignature({ ...args, acceptLegacy: true })).toBe(true);
  });

  it('accepts the raw bytes as well as the string of them', async () => {
    const ok = await verifyWebhookSignature({
      secret: 'whsec_live',
      body: new TextEncoder().encode(BODY),
      signature: header(['whsec_live'], TS, BODY),
      timestamp: TS,
      now,
    });
    expect(ok).toBe(true);
  });

  it('refuses rather than throwing when a header is missing', async () => {
    for (const bad of [null, undefined, '']) {
      expect(
        await verifyWebhookSignature({
          secret: 'whsec_live',
          body: BODY,
          signature: bad,
          timestamp: TS,
          now,
        }),
      ).toBe(false);
      expect(
        await verifyWebhookSignature({
          secret: 'whsec_live',
          body: BODY,
          signature: header(['whsec_live'], TS, BODY),
          timestamp: bad,
          now,
        }),
      ).toBe(false);
    }
  });

  it('refuses an empty secret instead of verifying against one', async () => {
    expect(
      await verifyWebhookSignature({
        secret: '',
        body: BODY,
        signature: header([''], TS, BODY),
        timestamp: TS,
        now,
      }),
    ).toBe(false);
  });
});
