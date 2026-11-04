/**
 * `startHeartbeat` — keep a heartbeat monitor green from a long-running
 * process (FormFlow 2026-11). Three lines replace the copy-pasted ping loop:
 *
 *   const stop = startHeartbeat({ url: process.env.PING_URL!, everyMs: 60_000 });
 *
 * It never throws and never lets a rejected ping escape as an unhandled
 * rejection: a monitoring helper that crashed the job it watches would be worse
 * than no monitoring. A `check` that throws (or answers `ok: false`) is
 * reported as `{ ok: false, detail }`, which the page reads as a partial
 * outage in the job's own words rather than the silence that only reads as an
 * outage after 1.5x the interval. Every ping carries its own timeout, so a
 * hung endpoint cannot stack up requests behind one another.
 */
export interface HeartbeatCheckResult {
  ok: boolean;
  /** Kept to 500 characters by the API; shown to your organization only. */
  detail?: string;
}

export interface StartHeartbeatOptions {
  /** The monitor's `pingUrl`. It holds the monitor's secret: keep it in a secret store. */
  url: string;
  /** Interval between pings. Ping at least once per monitor interval; the monitor goes down after 1.5x. */
  everyMs: number;
  /** Is the job healthy? Throwing is reported as a failed pass. Omit to ping a plain `ok`. */
  check?: () => Promise<HeartbeatCheckResult> | HeartbeatCheckResult;
  /** Per-ping timeout (default 10 000 ms, never longer than `everyMs`). */
  timeoutMs?: number;
  /** Called with a ping that could not be delivered. The default is silence. */
  onError?: (err: unknown) => void;
  /** For a runtime without a global `fetch`, and for tests. */
  fetch?: typeof fetch;
}

export function startHeartbeat(opts: StartHeartbeatOptions): () => void {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = Math.min(opts.timeoutMs ?? 10_000, opts.everyMs);
  let stopped = false;

  const beat = async (): Promise<void> => {
    try {
      let body: HeartbeatCheckResult = { ok: true };
      if (opts.check) {
        try {
          body = await opts.check();
        } catch (err) {
          body = { ok: false, detail: err instanceof Error ? err.message : String(err) };
        }
      }
      if (stopped) return;
      const res = await doFetch(opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body.ok ? { ok: true } : { ok: false, detail: (body.detail ?? '').slice(0, 500) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) opts.onError?.(new Error(`heartbeat ping answered ${res.status}`));
    } catch (err) {
      try {
        opts.onError?.(err);
      } catch {
        /* a throwing onError must not break the loop either */
      }
    }
  };

  void beat();
  const timer = setInterval(() => void beat(), opts.everyMs);
  // Never keep a process alive just to ping: the job's own work decides that.
  (timer as { unref?: () => void }).unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
