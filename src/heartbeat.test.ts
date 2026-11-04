import { afterEach, describe, expect, it, vi } from 'vitest';
import { startHeartbeat } from './heartbeat';

afterEach(() => vi.useRealTimers());

const okFetch = () => vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response('{"ok":true}', { status: 200 }));

describe('startHeartbeat', () => {
  it('pings at once and then every interval, until stopped', async () => {
    vi.useFakeTimers();
    const fetch = okFetch();
    const stop = startHeartbeat({ url: 'https://x/ping', everyMs: 1000, fetch });
    await vi.advanceTimersByTimeAsync(2500);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({ ok: true });
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('reports a throwing check as ok:false with its message', async () => {
    const fetch = okFetch();
    const stop = startHeartbeat({
      url: 'https://x/ping',
      everyMs: 60_000,
      fetch,
      check: async () => {
        throw new Error('queue lagging');
      },
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({ ok: false, detail: 'queue lagging' });
    stop();
  });

  it('never throws when the ping itself fails', async () => {
    const onError = vi.fn();
    const stop = startHeartbeat({
      url: 'https://x/ping',
      everyMs: 60_000,
      onError,
      fetch: vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    });
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    stop();
  });

  it('gives every ping a timeout signal', async () => {
    const fetch = okFetch();
    const stop = startHeartbeat({ url: 'https://x/ping', everyMs: 60_000, fetch });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(fetch.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
    stop();
  });
});
