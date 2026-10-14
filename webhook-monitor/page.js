// The monitor page. monitor.ts has what it talks to.
//
// The countdown is drawn from the server's clock, which this page measures its
// own against (sync), so it shows the same instant the server timed the
// requests by and not the time on this computer.

const $ = selector => document.querySelector(selector);
const view = name => {
  for (const element of document.querySelectorAll('[data-view]')) element.hidden = element.dataset.view !== name;
  $('[data-sign-out]').hidden = name !== 'desk';
};

let runs = [];
let hits = [];
let hookPath = '/hook';
/** Add this to this computer's clock for the server's. */
let offset = 0;
let rtt = null;
let stream = null;

const pad = (n, width = 2) => String(n).padStart(width, '0');

/** Milliseconds as seconds: 3.412 s, 1 m 03.412 s. */
function span(ms) {
  const sign = ms < 0 ? '-' : '';
  const total = Math.abs(ms);
  const minutes = Math.floor(total / 60_000);
  const seconds = (total % 60_000) / 1000;
  return minutes ? `${sign}${minutes} m ${pad(seconds.toFixed(3), 6)} s` : `${sign}${seconds.toFixed(3)} s`;
}

/** A moment, on this computer's wall clock, to the millisecond. */
function wall(ms) {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** m:ss.t for the big clock. */
function clockText(ms) {
  const tenths = Math.floor(Math.abs(ms) / 100);
  return `${Math.floor(tenths / 600)}:${pad(Math.floor(tenths / 10) % 60)}.${tenths % 10}`;
}

async function call(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(answer.error || response.statusText), { status: response.status });
  return answer;
}

function status(kind, text) {
  $('[data-status]').className = `status ${kind}`;
  $('[data-status-text]').textContent = text;
}

/** Measures the server's clock against this one: the quickest of five round trips is the most exact. */
async function sync() {
  let best = null;
  for (let i = 0; i < 5; i++) {
    const sent = Date.now();
    const { now } = await call('GET', '/api/ping');
    const took = Date.now() - sent;
    if (!best || took < best.took) best = { took, offset: now - (sent + took / 2) };
  }
  offset = best.offset;
  rtt = best.took;
  const sign = offset >= 0 ? '+' : '-';
  $('[data-sync]').textContent = `This computer's clock is ${sign}${Math.abs(Math.round(offset))} ms from the server's, `
    + `measured over a ${best.took} ms round trip. The click is timed to within about half of that.`;
}

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const runOf = id => runs.find(run => run.id === id);

function renderRuns() {
  $('[data-no-runs]').hidden = runs.length > 0;
  $('[data-runs]').hidden = runs.length === 0;
  const body = $('[data-runs] tbody');
  body.replaceChildren();
  for (const run of [...runs].reverse()) {
    const mine = hits.filter(hit => hit.run === run.id);
    const first = mine.length ? Math.min(...mine.map(hit => hit.sinceMs)) : null;
    const row = element('tr');
    const cells = [
      `#${run.id}`, run.label || '—', wall(run.at), `${run.seconds} s`, String(mine.length),
      first === null ? 'nothing yet' : `+${span(first)}${first > run.seconds * 1000 ? ' (after the timer)' : ''}`,
    ];
    for (const text of cells) row.append(element('td', '', text));
    body.append(row);
  }
}

function hitCard(hit, fresh) {
  const run = hit.run === null ? null : runOf(hit.run);
  const card = element('li', fresh ? 'hit hit--new' : 'hit');
  card.dataset.hit = hit.id;

  const top = element('div', 'hit__top');
  top.append(element('span', 'hit__since', hit.sinceMs === null ? 'no run' : `+${span(hit.sinceMs)}`));
  if (hit.sinceMs === null) {
    top.append(element('span', 'hit__badge', 'arrived before any run'));
  } else if (run) {
    const over = hit.sinceMs - run.seconds * 1000;
    top.append(over <= 0
      ? element('span', 'hit__badge in', `inside the ${run.seconds} s timer, ${span(-over)} to spare`)
      : element('span', 'hit__badge late', `${span(over)} after the ${run.seconds} s timer ended`));
    top.append(element('span', 'hit__badge', `run #${run.id}${run.label ? ` · ${run.label}` : ''}`));
  }
  top.append(element('span', 'hit__meta', `${wall(hit.at)} · #${hit.id}`));
  card.append(top);

  card.append(element('p', 'hit__line',
    `${hit.method} ${hit.path}${hit.query} · ${hit.size} bytes${hit.ip ? ` · from ${hit.ip}` : ''}`));

  const lags = hit.times.map(found => `${found.path}: ${new Date(found.time).toISOString()} was ${span(found.lagMs)} before it arrived`);
  if (hit.edgeMs !== undefined) lags.push(`X-Request-Start: stamped ${span(hit.edgeMs)} before this server got it`);
  if (hit.bodyMs > 5) lags.push(`the body took ${hit.bodyMs} ms to arrive after the headers`);
  if (lags.length) {
    const list = element('ul', 'hit__times');
    for (const line of lags) list.append(element('li', '', line));
    card.append(list);
  }

  const body = element('details');
  body.append(element('summary', '', hit.size ? 'Body' : 'Body (empty)'));
  const shown = hit.parsed !== undefined ? JSON.stringify(hit.parsed, null, 2) : hit.body;
  body.append(element('pre', '', shown + (hit.truncated ? '\n… (cut: only the start of a long body is kept)' : '')));
  if (hit.size) body.open = true;
  card.append(body);

  const headers = element('details');
  headers.append(element('summary', '', 'Headers'));
  headers.append(element('pre', '', Object.entries(hit.headers).map(([name, value]) => `${name}: ${value}`).join('\n')));
  card.append(headers);

  return card;
}

function renderHits() {
  const list = $('[data-hits]');
  list.replaceChildren(...[...hits].reverse().map(hit => hitCard(hit, false)));
  $('[data-no-hits]').hidden = hits.length > 0;
  $('[data-count]').textContent = hits.length ? `(${hits.length})` : '';
}

function addHit(hit) {
  if (hits.some(have => have.id === hit.id)) return;
  hits.push(hit);
  const card = hitCard(hit, true);
  $('[data-hits]').prepend(card);
  setTimeout(() => card.classList.remove('hit--new'), 4000);
  $('[data-no-hits]').hidden = true;
  $('[data-count]').textContent = `(${hits.length})`;
  renderRuns();
}

function addRun(run) {
  if (runs.some(have => have.id === run.id)) return;
  runs.push(run);
  renderRuns();
}

function setState(state) {
  runs = state.runs;
  hits = state.hits;
  hookPath = state.hookPath;
  $('[data-address]').textContent = `${location.origin}${hookPath}`;
  renderRuns();
  renderHits();
}

/** Draws the clock. The time comes from the run's click, so drawing late costs nothing. */
function tick() {
  const run = runs.at(-1);
  const timer = $('[data-timer]');
  if (!run) {
    timer.className = 'panel timer';
    $('[data-clock]').textContent = '—';
    $('[data-clock-what]').textContent = 'Not armed';
    $('[data-fill]').style.width = '0';
    return;
  }
  const elapsed = Date.now() + offset - run.at;
  const left = run.seconds * 1000 - elapsed;
  const mine = hits.filter(hit => hit.run === run.id);
  const name = `Run #${run.id}${run.label ? ` · ${run.label}` : ''}`;
  if (left > 0) {
    timer.className = 'panel timer counting';
    $('[data-clock]').textContent = clockText(left);
    $('[data-clock-what]').textContent = `${name} · counting down${mine.length ? ` · ${mine.length} arrived` : ''}`;
    $('[data-fill]').style.width = `${Math.min(100, (elapsed / (run.seconds * 1000)) * 100)}%`;
  } else {
    timer.className = 'panel timer over';
    $('[data-clock]').textContent = `+${clockText(-left)}`;
    $('[data-clock-what]').textContent = `${name} · the timer ended ${span(-left)} ago · `
      + (mine.length ? `${mine.length} arrived` : 'nothing has arrived yet');
  }
}

function connect() {
  stream?.close();
  stream = new EventSource('/api/stream');
  stream.addEventListener('state', event => setState(JSON.parse(event.data)));
  stream.addEventListener('run', event => addRun(JSON.parse(event.data)));
  stream.addEventListener('hit', event => addHit(JSON.parse(event.data)));
  stream.onopen = () => status('on', 'Live');
  stream.onerror = () => {
    if (stream.readyState === EventSource.CLOSED) return void start();
    status('off', 'Reconnecting');
  };
}

async function start() {
  try {
    setState(await call('GET', '/api/state'));
  } catch (error) {
    status('off', 'Signed out');
    if (error.status === 401) return view('door');
    $('[data-sign-in-error]').textContent = error.message;
    return view('door');
  }
  view('desk');
  connect();
  await sync().catch(() => {});
}

$('[data-sign-in]').addEventListener('submit', async event => {
  event.preventDefault();
  const error = $('[data-sign-in-error]');
  error.hidden = true;
  try {
    await call('POST', '/api/session', { token: new FormData(event.target).get('token') });
    event.target.reset();
    await start();
  } catch (failed) {
    error.textContent = failed.message;
    error.hidden = false;
  }
});

$('[data-sign-out]').addEventListener('click', async () => {
  stream?.close();
  await call('DELETE', '/api/session').catch(() => {});
  status('off', 'Signed out');
  view('door');
});

$('[data-arm]').addEventListener('submit', async event => {
  event.preventDefault();
  // Taken first thing: the moment of the click, on the server's clock.
  const clickedAt = Date.now() + offset;
  const form = new FormData(event.target);
  try {
    addRun(await call('POST', '/api/arm', {
      seconds: Number(form.get('seconds')), label: String(form.get('label') ?? ''), clickedAt,
    }));
  } catch (error) {
    $('[data-clock-what]').textContent = error.message;
  }
});

$('[data-copy]').addEventListener('click', async event => {
  try {
    await navigator.clipboard.writeText($('[data-address]').textContent);
    event.target.textContent = 'Copied';
  } catch {
    event.target.textContent = 'Select it and copy';
  }
  setTimeout(() => { event.target.textContent = 'Copy'; }, 1500);
});

$('[data-test]').addEventListener('click', () => {
  // The time inside is this page's, so the card also shows how late a sender's own time reads.
  fetch(hookPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ test: true, sent_at: new Date().toISOString() }),
  }).catch(() => {});
});

$('[data-clear]').addEventListener('click', () => call('POST', '/api/clear').catch(() => {}));

setInterval(tick, 50);
setInterval(() => sync().catch(() => {}), 300_000);
start();
