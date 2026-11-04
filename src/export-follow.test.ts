import { describe, expect, it } from 'vitest';
import { send, ForumulateError, type Transport } from './http';

/** Calendoro 2026-11-01: exportCsv handed back the job on a 202 instead of the CSV. */
function transport(answers: { status: number; body: string; type: string }[]) {
  const urls: string[] = [];
  const t: Transport = {
    baseUrl: 'http://api.test',
    credentials: false,
    headers: {},
    maxRetries: 0,
    autoIdempotencyKey: false,
    fetch: (async (url: string) => {
      urls.push(url);
      const a = answers.shift()!;
      return new Response(a.body, { status: a.status, headers: { 'content-type': a.type } });
    }) as unknown as typeof fetch,
  };
  return { t, urls };
}

const job = (state: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 'e1',
    kind: 'export.csv',
    state,
    links: { self: '/api/orgs/o1/jobs/e1?kind=export.csv', result: state === 'completed' ? '/api/orgs/o1/exports/e1/download' : null },
    ...extra,
  });
const json = 'application/json';

describe('a queued CSV export', () => {
  it('waits for the job and returns the file, as the 200 would', async () => {
    const { t, urls } = transport([
      { status: 202, body: job('queued'), type: json },
      { status: 200, body: job('completed'), type: json },
      { status: 200, body: 'a,b\n1,2\n', type: 'text/csv' },
    ]);
    expect(await send(t, { method: 'GET', path: '/orgs/o1/audit/export.csv' })).toBe('a,b\n1,2\n');
    expect(urls.slice(1)).toEqual(['http://api.test/orgs/o1/jobs/e1?kind=export.csv', 'http://api.test/orgs/o1/exports/e1/download']);
  });

  it('throws the job error when the export fails', async () => {
    const { t } = transport([
      { status: 202, body: job('failed', { error: { code: 'job.failed', message: 'boom' } }), type: json },
    ]);
    await expect(send(t, { method: 'GET', path: '/orgs/o1/audit/export.csv' })).rejects.toBeInstanceOf(ForumulateError);
  });

  it('leaves any other 202, and raw callers, alone', async () => {
    const other = transport([{ status: 202, body: JSON.stringify({ kind: 'backup', id: 'b' }), type: json }]);
    expect(await send(other.t, { method: 'GET', path: '/x' })).toEqual({ kind: 'backup', id: 'b' });
    const raw = transport([{ status: 202, body: job('queued'), type: json }]);
    expect(((await send(raw.t, { method: 'GET', path: '/x', raw: true })) as Response).status).toBe(202);
  });
});
