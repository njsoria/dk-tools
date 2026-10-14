/**
 * The webhook monitor: an address to point a webhook at, and a page that shows
 * each request the moment it arrives and how long after you pressed Arm.
 *
 *   ANY  /hook, /hook/...    the address under test; answers 200 and records the request
 *   GET  /                   the page (page.html, page.css, page.js beside this file)
 *   GET  /health             is it up
 *   POST /api/session        sign in with the monitor token
 *   DELETE /api/session      sign out
 *   GET  /api/ping           this server's clock, for the page to measure its own against
 *   GET  /api/state          the address, the runs and the requests so far
 *   GET  /api/stream         the same, then each run and request as it happens
 *   POST /api/arm            start a run: a countdown of n seconds, from the moment of the click
 *   POST /api/clear          forget the runs and the requests
 *
 * A run is the timer. Every request that arrives is filed under the latest
 * run, with the milliseconds between the click and the request's arrival here.
 * The click's time is the page's, corrected to this server's clock, so the
 * time the click took to reach the server is not counted against the sender.
 *
 * Nothing is kept past a restart, and only the last few hundred requests while
 * running. The page and /api need MONITOR_TOKEN; /hook needs nothing, because
 * a sender cannot be told to sign in. HOOK_KEY, when set, becomes part of the
 * address (/hook/<HOOK_KEY>), so only a sender given it is recorded.
 */

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';

export type MonitorDeps = {
  version: string;
  /** MONITOR_TOKEN. Empty: nobody can sign in. */
  token: string;
  /** HOOK_KEY. Empty: /hook and anything under it records. */
  hookKey?: string;
  log?: (line: string) => void;
  /** Milliseconds since 1970. Replaced in tests. */
  now?: () => number;
};

export type Run = {
  id: number;
  label: string;
  seconds: number;
  /** The moment of the click, on this server's clock, ms. */
  at: number;
};

/** A time found inside a payload, and how long before the request arrived it was. */
export type PayloadTime = { path: string; time: number; lagMs: number };

export type Hit = {
  id: number;
  /** When the request reached this server, ms. */
  at: number;
  /** The run it falls under: the latest when it arrived. Null before the first. */
  run: number | null;
  /** Milliseconds from that run's click to `at`. */
  sinceMs: number | null;
  method: string;
  path: string;
  query: string;
  ip: string;
  /** Authorization and cookies are replaced by a note of their length. */
  headers: Record<string, string>;
  /** Bytes the sender sent. */
  size: number;
  body: string;
  /** The body is longer than what is kept here. */
  truncated: boolean;
  /** The body read as JSON or as a form, when it is one. */
  parsed?: unknown;
  times: PayloadTime[];
  /** Milliseconds the body took to arrive after the headers. */
  bodyMs: number;
  /** Milliseconds between the front door stamping the request and this server getting it, where the header says. */
  edgeMs?: number;
};

const KEPT_HITS = 200;
const KEPT_RUNS = 50;
const KEPT_BODY = 64_000;
const READ_BODY = 1_000_000;
const MOST_STREAMS = 10;
const MOST_WRONG = 10;
const SESSION_DAYS = 7;
const COOKIE = 'monitor_session';
// A click is older than the request that carries it by about a round trip. Anything beyond this is a wrong clock.
const MOST_CLICK_AGE_MS = 10_000;

const file = (name: string) => readFileSync(new URL(name, import.meta.url));

const PAGE_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
    + "img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

const digest = (value: string) => crypto.createHash('sha256').update(value).digest();
export const sameSecret = (given: string | undefined, secret: string) =>
  Boolean(secret) && given !== undefined && crypto.timingSafeEqual(digest(given), digest(secret));

const sessionValue = (token: string) => crypto.createHmac('sha256', token).update('webhook monitor session').digest('base64url');

function cookieFrom(header: string | undefined): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE) return value.join('=');
  }
  return undefined;
}

const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'x-auth-token']);

function headersOf(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const text = Array.isArray(value) ? value.join(', ') : value ?? '';
    // A key is never shown or kept; that it was sent, and how long it is, is what a test needs.
    headers[name] = SECRET_HEADERS.has(name) ? `(sent, ${text.length} characters)` : text;
  }
  return headers;
}

/** A moment in seconds or milliseconds since 1970, or an ISO time with its zone, as milliseconds. */
function momentOf(value: unknown, named: boolean): number | null {
  if (named && (typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)))) {
    const n = Number(value);
    if (n >= 1e9 && n < 1e10) return n * 1000;
    if (n >= 1e12 && n < 1e13) return n;
    return null;
  }
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\d[T ].*(Z|[+-]\d\d:?\d\d)$/.test(value)) {
    const time = Date.parse(value);
    return Number.isNaN(time) ? null : time;
  }
  return null;
}

const TIME_NAME = /time|millis|stamp|date|(^|_)at$|At$/;

/** The times a payload says about itself, so how late it was can be read off the page. */
export function timesIn(payload: unknown, arrived: number): PayloadTime[] {
  const found: PayloadTime[] = [];
  const walk = (value: unknown, path: string, depth: number) => {
    if (found.length >= 10 || depth > 4) return;
    if (Array.isArray(value)) return value.slice(0, 20).forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) walk(item, path ? `${path}.${key}` : key, depth + 1);
      return;
    }
    const time = momentOf(value, TIME_NAME.test(path.split('.').pop() ?? ''));
    // A day either way: a time further off is a date of something else.
    if (time !== null && Math.abs(arrived - time) < 86_400_000) found.push({ path, time, lagMs: Math.round(arrived - time) });
  };
  walk(payload, '', 0);
  return found;
}

/** The time a front door stamped on a request (X-Request-Start), when it did and it is believable. */
function edgeStamp(header: string | undefined, arrived: number): number | null {
  const n = Number(String(header ?? '').replace(/^t=/, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1e11 ? n * 1000 : n;
  return Math.abs(arrived - ms) < 600_000 ? ms : null;
}

function parseBody(body: string, type: string): unknown {
  try {
    if (/json/i.test(type) || /^\s*[{[]/.test(body)) return JSON.parse(body);
    if (/x-www-form-urlencoded/i.test(type)) return Object.fromEntries(new URLSearchParams(body));
  } catch {
    // Not what it said it was; the raw body is shown either way.
  }
  return undefined;
}

async function readBody(request: IncomingMessage): Promise<{ text: string; size: number; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let kept = 0;
  let size = 0;
  try {
    for await (const chunk of request as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (kept < READ_BODY) {
        chunks.push(chunk);
        kept += chunk.length;
      }
    }
  } catch {
    // The sender hung up mid-body. What came is still worth showing.
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return { text: text.slice(0, KEPT_BODY), size, truncated: text.length > KEPT_BODY || size > kept };
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const { text } = await readBody(request);
  try {
    const body: unknown = JSON.parse(text);
    return body && typeof body === 'object' ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function createMonitor(deps: MonitorDeps): Server {
  const log = deps.log ?? (line => console.log(line));
  const now = deps.now ?? Date.now;
  const files: Record<string, { type: string; body: Buffer }> = {
    '/': { type: 'text/html; charset=utf-8', body: file('page.html') },
    '/page.css': { type: 'text/css; charset=utf-8', body: file('page.css') },
    '/page.js': { type: 'text/javascript; charset=utf-8', body: file('page.js') },
  };
  // The address under test, as the page is told it.
  const hookPath = deps.hookKey ? `/hook/${deps.hookKey}` : '/hook';
  const runs: Run[] = [];
  const hits: Hit[] = [];
  const pages = new Set<{ send(event: string, data: unknown): void; end(): void }>();
  let lastRun = 0;
  let lastHit = 0;
  let wrong: number[] = [];

  const broadcast = (event: string, data: unknown) => pages.forEach(page => page.send(event, data));
  const snapshot = () => ({ now: now(), version: deps.version, hookPath, runs, hits });

  const isHook = (path: string) => {
    if (!(path === '/hook' || path.startsWith('/hook/'))) return false;
    return !deps.hookKey || path === hookPath || path.startsWith(`${hookPath}/`);
  };

  const fromThePage = (request: IncomingMessage) => {
    try {
      return new URL(request.headers.origin ?? '').host === request.headers.host;
    } catch {
      return false;
    }
  };
  const allowed = (request: IncomingMessage) => {
    if (!deps.token) return false;
    const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '')?.[1]?.trim();
    if (sameSecret(bearer, deps.token)) return true;
    if (!sameSecret(cookieFrom(request.headers.cookie), sessionValue(deps.token))) return false;
    // The cookie alone lets a request read; to change something it has to come from the page itself.
    return request.method === 'GET' || request.method === 'HEAD' || fromThePage(request);
  };
  const cookie = (value: string, secure: boolean) =>
    `${COOKIE}=${value}; Path=/; Max-Age=${value ? SESSION_DAYS * 86_400 : 0}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;

  const json = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
    response.end(JSON.stringify(body));
  };

  async function record(request: IncomingMessage, response: ServerResponse, path: string, query: string) {
    // Stamped before the body is read: this is when the sender's request got here.
    const at = now();
    const run = runs.at(-1) ?? null;
    const body = await readBody(request);
    const bodyMs = now() - at;
    const type = String(request.headers['content-type'] ?? '');
    const parsed = parseBody(body.text, type);
    const edge = edgeStamp(String(request.headers['x-request-start'] ?? ''), at);
    const hit: Hit = {
      id: ++lastHit,
      at,
      run: run?.id ?? null,
      sinceMs: run ? at - run.at : null,
      method: request.method ?? 'GET',
      path,
      query,
      ip: String(request.headers['x-forwarded-for'] ?? request.socket.remoteAddress ?? '').split(',')[0]!.trim(),
      headers: headersOf(request),
      size: body.size,
      body: body.text,
      truncated: body.truncated,
      ...(parsed !== undefined ? { parsed } : {}),
      times: timesIn(parsed, at),
      bodyMs,
      ...(edge !== null ? { edgeMs: Math.round(at - edge) } : {}),
    };
    hits.push(hit);
    if (hits.length > KEPT_HITS) hits.shift();
    broadcast('hit', hit);
    log(`hit ${hit.id}: ${hit.method} ${hit.path}, ${hit.size} bytes`
      + (run ? `, ${((hit.sinceMs ?? 0) / 1000).toFixed(3)} s after run ${run.id}${run.label ? ` (${run.label})` : ''}` : ', before any run'));
    json(response, 200, { ok: true, id: hit.id, receivedAt: new Date(at).toISOString() });
  }

  const server = createServer(async (request, response) => {
    const { pathname, search } = new URL(request.url ?? '/', 'http://localhost');
    const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
    const method = request.method ?? 'GET';
    try {
      if (isHook(path)) return await record(request, response, pathname, search);

      if (method === 'GET' && path === '/health') return json(response, 200, { ok: true, version: deps.version });

      const page = method === 'GET' ? files[path] : undefined;
      if (page) {
        response.writeHead(200, { 'Content-Type': page.type, ...PAGE_HEADERS });
        return void response.end(page.body);
      }

      if (path === '/api/session' && method === 'POST') {
        if (!deps.token) return json(response, 503, { error: 'MONITOR_TOKEN is not set on the server, so there is nothing to sign in with.' });
        wrong = wrong.filter(when => when > now() - 60_000);
        if (wrong.length >= MOST_WRONG) return json(response, 429, { error: 'Too many wrong tokens. Wait a minute and try again.' });
        if (!sameSecret(String((await jsonBody(request)).token ?? '').trim(), deps.token)) {
          wrong.push(now());
          log('sign-in refused: wrong token');
          return json(response, 401, { error: 'That is not the monitor token.' });
        }
        // Railway's router answers https and passes the request on as http.
        return json(response, 200, {}, { 'Set-Cookie': cookie(sessionValue(deps.token), request.headers['x-forwarded-proto'] === 'https') });
      }
      if (path === '/api/session' && method === 'DELETE') {
        return json(response, 200, {}, { 'Set-Cookie': cookie('', request.headers['x-forwarded-proto'] === 'https') });
      }

      if (!path.startsWith('/api/')) return json(response, 404, { error: 'Not found' });
      if (!allowed(request)) return json(response, 401, { error: 'Sign in first.' });

      if (path === '/api/ping' && method === 'GET') return json(response, 200, { now: now() });
      if (path === '/api/state' && method === 'GET') return json(response, 200, snapshot());

      if (path === '/api/stream' && method === 'GET') {
        if (pages.size >= MOST_STREAMS) return json(response, 503, { error: 'Too many pages are open.' });
        // X-Accel-Buffering: a proxy in front must pass each event on as it is written.
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        const send = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        const open = { send, end: () => void response.end() };
        send('state', snapshot());
        pages.add(open);
        // Routers drop a connection nothing has crossed for a while.
        const beat = setInterval(() => response.write(': still here\n\n'), 20_000);
        response.on('close', () => {
          clearInterval(beat);
          pages.delete(open);
        });
        return;
      }

      if (path === '/api/arm' && method === 'POST') {
        const body = await jsonBody(request);
        const seconds = Math.round(Number(body.seconds));
        if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600) {
          return json(response, 400, { error: 'seconds is a whole number from 1 to 3600.' });
        }
        const arrived = now();
        // The click on the page's clock, moved onto this one. A wrong clock falls back to the moment the click arrived.
        const clicked = Number(body.clickedAt);
        const at = Number.isFinite(clicked) && clicked > arrived - MOST_CLICK_AGE_MS ? Math.min(clicked, arrived) : arrived;
        const run: Run = { id: ++lastRun, label: String(body.label ?? '').trim().slice(0, 60), seconds, at };
        runs.push(run);
        if (runs.length > KEPT_RUNS) runs.shift();
        broadcast('run', run);
        log(`run ${run.id} armed: ${seconds} s${run.label ? ` (${run.label})` : ''}, the click ${arrived - at} ms before it arrived`);
        return json(response, 200, run);
      }

      if (path === '/api/clear' && method === 'POST') {
        runs.length = 0;
        hits.length = 0;
        broadcast('state', snapshot());
        return json(response, 200, {});
      }

      return json(response, 404, { error: 'Not found' });
    } catch (error) {
      log(`request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (response.headersSent) return void response.end();
      return json(response, 500, { error: 'Something went wrong' });
    }
  });

  // Closing waits for what is open to finish, which a page being fed never does: those are let go first.
  const close = server.close.bind(server);
  server.close = callback => {
    pages.forEach(page => page.end());
    return close(callback);
  };

  return server;
}
