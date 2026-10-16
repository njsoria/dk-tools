# Webhook monitor

An address to point a webhook at, and a page that shows each request the moment
it arrives, timed from a click of yours. It exists to measure a sender's delay
exactly: press **Arm** as you press the button that makes the sender send, and
the page counts down your timer and stamps every request with the time since
the click.

It runs with no packages (Node 24 runs the TypeScript as it is) and shares
nothing with the rest of this repository, so it is a Railway service of its own.

## How it works

1. **Arm** (or the space bar, anywhere on the page outside a text field) takes
   a number of seconds and an optional label. The time of your
   click is measured on your computer's clock and moved onto the server's (the
   page times five round trips and uses the quickest), so the time the click
   took to reach the server is not counted against the sender.
2. Every request to `/hook` (any method, any body) is stamped with the server's
   clock the moment its headers arrive, answered `200`, and sent to the page
   live. The page shows **+3.412 s** from the click, whether that was inside
   the timer or how long after it ended, the wall-clock time to the
   millisecond, the body and the headers.
3. A request is filed under the latest run. Arm again for each trial; the
   **Runs** table lines the trials up (requests per run, and when the first
   arrived).
4. Times inside a payload are read too. A field whose name says time, millis or
   stamp, holding seconds or milliseconds since 1970, or any ISO time with a
   zone, is shown with how long before arrival it was: how late the sender's
   own report is against its own clock. If the front door stamps
   `X-Request-Start`, that gap is shown as well.

What it does not do: tell you where the delay was. It shows when the request
reached this server; whether the sender queued it, a router held it or the
network was slow is for the sender's side to answer. Two clocks are involved
(yours and the server's) and both are Date.now(), so their agreement is as good
as the machines' NTP; the page prints the offset it measured.

A key the sender sends (`Authorization`, `Cookie`, `X-Api-Key`) is never kept or
shown: the page shows only that it was sent and how long it was. The body is
shown whole, up to 64 KB, so don't point a sender at it that puts client data
in the body unless you mean to. Nothing is stored past a restart; the last 200
requests and 50 runs are held in memory.

## Setting it up on Railway

A new service in the Railway project, from this repository, with:

| Setting | Value |
|---|---|
| Root directory | `webhook-monitor` |
| Variable `MONITOR_TOKEN` | Opens the page. A long random value: `openssl rand -hex 32` |
| Variable `HOOK_KEY` | Optional, and worth setting. Becomes part of the address (`/hook/<key>`), so only a sender you gave it to is recorded. Letters, digits and `- _ . ~` |

Then give the service a domain (Settings → Networking → Generate Domain) and
open it. Sign in with the token; the page shows the address to copy.

`railway.json` holds the start command and the health check (`/health`).

Locally:

```bash
cd webhook-monitor
MONITOR_TOKEN=test HOOK_KEY=abc node server.ts
```

## Timing a sender's own webhook

For a sender that lets you choose the address it posts to (a workflow rule, a
function, a callback URL), point a copy of it at the monitor, leaving its
`Authorization` line off. Then, for each trial:

1. Pick a label (`Interested, rep 1`) and the seconds you'll allow (120).
2. Press **Arm**, or the space bar, as you press the button that makes the
   sender send.
3. Watch the card appear. **+x s** is the delay from your click to the monitor.
   The payload's own times, if it carries any, show against arrival.

Do several trials, at different times of day: one reading says little about how
long a delay usually is.

## Pieces

| Piece | File |
|---|---|
| The routes and what they record | `monitor.ts` |
| Starts it | `server.ts` |
| The page | `page.html`, `page.css`, `page.js` |
| Tests, run with `npm test` | `monitor.test.ts` |
