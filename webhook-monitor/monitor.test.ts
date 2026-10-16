/**
 * The monitor over real HTTP, with a clock the test moves so the timings are
 * exact.
 */

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { type Hit, type Run, createMonitor, timesIn } from './monitor.ts';

const TOKEN = 'monitor-secret';
const T0 = Date.parse('2026-10-13T20:00:00.000Z');

let server: Server | null = null;
afterEach(() => new Promise<void>(done => (server ? server.close(() => done()) : done())));

async function start(options: { hookKey?: string; token?: string } = {}) {
  const clock = { time: T0 };
  server = createMonitor({
    version: '0.0.0-test',
    token: options.token ?? TOKEN,
    hookKey: options.hookKey,
    log: () => {},
    now: () => clock.time,
  });
  await new Promise<void>(done => server!.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const bearer = { Authorization: `Bearer ${TOKEN}` };
  const api = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { 'Content-Type': 'application/json', ...bearer, ...init.headers } });
  const state = async () => (await api('/api/state')).json() as Promise<{ runs: Run[]; hits: Hit[]; hookPath: string }>;
  return { base, clock, api, state };
}

describe('the address under test', () => {
  it('records any method and answers 200 at once', async () => {
    const { base, state } = await start();
    const post = await fetch(`${base}/hook`, { method: 'POST', body: '{"a":1}', headers: { 'Content-Type': 'application/json' } });
    const get = await fetch(`${base}/hook/anything/at/all?x=1`);
    expect(post.status).toBe(200);
    expect(get.status).toBe(200);
    const { hits } = await state();
    expect(hits.map(hit => [hit.method, hit.path, hit.query])).toEqual([
      ['POST', '/hook', ''],
      ['GET', '/hook/anything/at/all', '?x=1'],
    ]);
    expect(hits[0]!.parsed).toEqual({ a: 1 });
    expect(hits[0]!.run).toBeNull();
    expect(hits[0]!.sinceMs).toBeNull();
  });

  it('reads a form body as fields', async () => {
    const { base, state } = await start();
    await fetch(`${base}/hook`, { method: 'POST', body: 'CallSid=CA1&From=%2B1555', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    expect((await state()).hits[0]!.parsed).toEqual({ CallSid: 'CA1', From: '+1555' });
  });

  it('keeps a key sent to it out of what the page shows, and says it was sent', async () => {
    const { base, state } = await start();
    await fetch(`${base}/hook`, { method: 'POST', body: '{}', headers: { Authorization: 'Bearer sk-live-abcdef', Cookie: 'a=b' } });
    const { headers } = (await state()).hits[0]!;
    expect(JSON.stringify(headers)).not.toContain('sk-live');
    expect(headers.authorization).toBe('(sent, 21 characters)');
    expect(headers.cookie).toBe('(sent, 3 characters)');
  });

  it('records only the keyed address when HOOK_KEY is set', async () => {
    const { base, state } = await start({ hookKey: 'k3y' });
    expect((await fetch(`${base}/hook`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${base}/hook/other`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${base}/hook/k3y`, { method: 'POST' })).status).toBe(200);
    expect((await fetch(`${base}/hook/k3y/more`, { method: 'POST' })).status).toBe(200);
    const after = await state();
    expect(after.hits).toHaveLength(2);
    expect(after.hookPath).toBe('/hook/k3y');
  });

  it('keeps only the start of a long body but counts all of it', async () => {
    const { base, state } = await start();
    await fetch(`${base}/hook`, { method: 'POST', body: 'x'.repeat(100_000) });
    const [hit] = (await state()).hits;
    expect(hit!.size).toBe(100_000);
    expect(hit!.body).toHaveLength(64_000);
    expect(hit!.truncated).toBe(true);
  });

  it('keeps the last 200 requests', async () => {
    const { base, state } = await start();
    for (let i = 0; i < 205; i++) await fetch(`${base}/hook`, { method: 'POST' });
    const { hits } = await state();
    expect(hits).toHaveLength(200);
    expect(hits[0]!.id).toBe(6);
  });
});

describe('a run', () => {
  it('times a request from the click, on the server clock', async () => {
    const { base, clock, api, state } = await start();
    // The click happened 40 ms before the arm request reached the server.
    clock.time = T0 + 1000;
    const arm = await api('/api/arm', { method: 'POST', body: JSON.stringify({ seconds: 30, label: 'Interested', clickedAt: T0 + 960 }) });
    expect(arm.status).toBe(200);
    expect((await arm.json() as Run).at).toBe(T0 + 960);

    clock.time = T0 + 4372;
    await fetch(`${base}/hook`, { method: 'POST', body: '{}' });
    const [hit] = (await state()).hits;
    expect(hit!.run).toBe(1);
    expect(hit!.sinceMs).toBe(3412);
  });

  it('files a request under the latest run, even after its timer ended', async () => {
    const { base, clock, api, state } = await start();
    await api('/api/arm', { method: 'POST', body: JSON.stringify({ seconds: 5 }) });
    clock.time = T0 + 9000;
    await fetch(`${base}/hook`, { method: 'POST' });
    await api('/api/arm', { method: 'POST', body: JSON.stringify({ seconds: 5 }) });
    clock.time = T0 + 9500;
    await fetch(`${base}/hook`, { method: 'POST' });
    const { hits } = await state();
    expect(hits.map(hit => [hit.run, hit.sinceMs])).toEqual([[1, 9000], [2, 500]]);
  });

  it('does not trust a click time that is in the future or long gone', async () => {
    const { clock, api } = await start();
    clock.time = T0 + 60_000;
    const future = await (await api('/api/arm', { method: 'POST', body: JSON.stringify({ seconds: 5, clickedAt: T0 + 90_000 }) })).json() as Run;
    expect(future.at).toBe(T0 + 60_000);
    const old = await (await api('/api/arm', { method: 'POST', body: JSON.stringify({ seconds: 5, clickedAt: T0 }) })).json() as Run;
    expect(old.at).toBe(T0 + 60_000);
  });

  it('refuses a timer that is not 1 to 3600 seconds', async () => {
    const { api } = await start();
    for (const seconds of [0, -3, 3601, 'soon', null]) {
      expect((await api('/api/arm', { method: 'POST', body: JSON.stringify({ seconds }) })).status).toBe(400);
    }
  });

  it('is forgotten by clear', async () => {
    const { base, api, state } = await start();
    await api('/api/arm', { method: 'POST', body: JSON.stringify({ seconds: 5 }) });
    await fetch(`${base}/hook`, { method: 'POST' });
    await api('/api/clear', { method: 'POST' });
    const after = await state();
    expect(after.runs).toEqual([]);
    expect(after.hits).toEqual([]);
  });
});

describe('the live feed', () => {
  it('sends the state, then each run and request as it happens', async () => {
    const { base, api } = await start();
    const response = await fetch(`${base}/api/stream`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const until = async (needle: string) => {
      while (!text.includes(needle)) text += decoder.decode((await reader.read()).value);
    };

    await until('event: state');
    await api('/api/arm', { method: 'POST', body: JSON.stringify({ seconds: 5 }) });
    await until('event: run');
    await fetch(`${base}/hook`, { method: 'POST', body: '{"ping":true}' });
    await until('event: hit');
    expect(text).toContain('"ping":true');
    await reader.cancel();
  });
});

describe('signing in', () => {
  it('keeps the page and the api to someone with the token', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/api/state`)).status).toBe(401);
    expect((await fetch(`${base}/api/state`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await fetch(`${base}/`)).status).toBe(200);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('hands a cookie for the right token and then lets the cookie read', async () => {
    const { base } = await start();
    const bad = await fetch(`${base}/api/session`, { method: 'POST', body: JSON.stringify({ token: 'nope' }) });
    expect(bad.status).toBe(401);
    const good = await fetch(`${base}/api/session`, { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
    expect(good.status).toBe(200);
    const cookie = good.headers.get('set-cookie')!.split(';')[0]!;
    expect((await fetch(`${base}/api/state`, { headers: { Cookie: cookie } })).status).toBe(200);
  });

  it('lets a cookie change things only from the page itself', async () => {
    const { base } = await start();
    const good = await fetch(`${base}/api/session`, { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
    const cookie = good.headers.get('set-cookie')!.split(';')[0]!;
    const arm = (origin?: string) => fetch(`${base}/api/arm`, {
      method: 'POST', body: JSON.stringify({ seconds: 5 }), headers: { Cookie: cookie, ...(origin ? { Origin: origin } : {}) },
    });
    expect((await arm()).status).toBe(401);
    expect((await arm('https://evil.example')).status).toBe(401);
    expect((await arm(base)).status).toBe(200);
  });

  it('cannot be signed in to with no token set', async () => {
    const { base } = await start({ token: '' });
    const attempt = await fetch(`${base}/api/session`, { method: 'POST', body: JSON.stringify({ token: '' }) });
    expect(attempt.status).toBe(503);
    expect((await fetch(`${base}/api/state`, { headers: { Authorization: 'Bearer ' } })).status).toBe(401);
  });
});

describe('times inside a payload', () => {
  const arrived = Date.parse('2026-10-13T20:00:46.000Z');

  it('finds a time in seconds, in milliseconds and in ISO, and says how long before arrival', () => {
    const found = timesIn({
      sms_sent_time_millis: arrived - 46_000,
      call: { start_time: String(Math.floor((arrived - 30_000) / 1000)), ended_at: '2026-10-13T20:00:40+00:00' },
    }, arrived);
    expect(found).toEqual([
      { path: 'sms_sent_time_millis', time: arrived - 46_000, lagMs: 46_000 },
      { path: 'call.start_time', time: Math.floor((arrived - 30_000) / 1000) * 1000, lagMs: 30_000 },
      { path: 'call.ended_at', time: arrived - 6000, lagMs: 6000 },
    ]);
  });

  it('ignores numbers that are not times, and times far from now', () => {
    expect(timesIn({ credits: 1234567890123, id: 1723379118, old_time: 1723379118, when: '2020-01-01T00:00:00Z' }, arrived)).toEqual([]);
  });

  it('ignores a time written without a zone, which could be any', () => {
    expect(timesIn({ call_time: '2026-10-13 20:00:00' }, arrived)).toEqual([]);
  });
});
