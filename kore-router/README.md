<img src="assets/logo.svg" alt="Kore Router" width="96" height="96" align="left">

# Kore Router

A Claude Code plugin that sends each prompt to the model and effort it
deserves, so you can leave your session on your strongest model and stop
paying for it on small jobs.

<br clear="left">

For every prompt you type, the router picks a model (Haiku, Sonnet or Opus)
and an effort level, and applies them to that turn's requests. Your session's
own setting is untouched, and `/router off` hands it straight back.

## Install

```bash
/plugin marketplace add njsoria/dk-tools
/plugin install kore-router@dk-tools
```

Then start a new session. The router says it is on with a toast, `router: on`
appears in the status line, and the pane opens by itself (set `"openPane": false`
in `routes.json` to stop that).

## How it picks

1. **Rules first.** Each entry in `rules` in `routes.json` is a regular
   expression, tried in order and case-insensitive. The first match decides the
   route with no classifier call (`ultrathink` goes to Opus at max effort, and
   `typo`, `rename` or `format` at the start of a prompt goes to Haiku at low).
2. **Otherwise a classifier.** It reads the prompt and the last few messages
   (so "yes, go ahead" is judged by the job under way) against the `when`
   descriptions in `routes.json`, and answers with a model and an effort.
   - **Jev** (the default) is TypeSafe's classifier. It needs a
     `TYPESAFE_API_KEY`, set in the environment or in a `.env` file beside
     `routes.json`. At about $0.042 per million input tokens, a routed prompt
     costs a few thousandths of a cent.
   - **Haiku** (`"classifier": "haiku"`) runs on your session's own login, so it
     needs no key. It is slower.
3. **Unsure means more capable.** Below `minConfidence`, the router takes the
   stronger of the two likeliest models and rounds the effort up.

Two guards keep a switch from costing more than it saves:

- Switching models re-reads the whole conversation uncached, so the router only
  steps *down* a tier while the conversation is under `stepDownUntilMessages`
  (30). Past that, it keeps the model and still applies the effort.
- A turn keeps the route it began on. A prompt typed mid-turn doesn't switch
  models under it, and subagents keep the model they were started with.

If routing fails for any reason (no key, timeout, an unknown model), your prompt
runs as the session set it. The router is never the reason a prompt fails.

## Commands

| Command | What it does |
| --- | --- |
| `/router` | Shows whether the router is on and the last route |
| `/router on`, `/router off` | Turn it on, or hand the session back to its own model |
| `/router pane` | Open a live pane of this session's routes |
| `/router savings` | Price what the router saved against your baseline model |
| `/router savings sonnet` | The same, against another model from `routes.json` |
| `/router savings session` | Against whatever model you had selected for each turn |
| `/router <a prompt>` | Show the route a prompt would get, without sending it |

## Savings

Each routed turn adds a line to `routes.spend.jsonl` with the model and effort
you had selected, the model the router ran, and the turn's token counts.
`/router savings` prices those same tokens on both models and reports the
difference.

The baseline defaults to `{ "model": "opus", "effort": "xhigh" }` in
`routes.json`. Prices sit beside it, in dollars per million tokens. Check them
against current pricing: Haiku's cache prices are assumed, and its higher rate
above 100K prompt tokens isn't modeled.

What the figure leaves out:

- It prices the model, not the effort, and uses the same tokens on both sides.
  A lower effort also thinks less, so the real saving is probably somewhat
  larger.
- The classifier's own cost isn't counted.
- Turns from before the spend log existed have no token counts.

## Configuration

All of it is in [`routes.json`](routes.json).

| Key | Meaning |
| --- | --- |
| `classifier` | `jev` or `haiku` |
| `minConfidence` | Below this, take the more capable choice (0 to 1) |
| `timeoutMs` | How long to wait for the classifier |
| `openPane` | Open the pane when a session starts (`true`), or leave it to `/router pane` |
| `stepDownUntilMessages` | Longest conversation the router will step down a tier in |
| `baseline` | What `/router savings` compares against by default |
| `pricing` | Dollars per million tokens, by model id |
| `rules` | `match` (regex), `model`, `effort`, `why`, tried in order |
| `models` | `name`, `id`, and a `when` the classifier reads. Order them weakest to strongest |
| `efforts` | Levels, weakest to strongest, each with a `when` |

The `when` text is the router's whole idea of your work. Edit it to describe
the jobs you'd send to each model.

## Files

- `hooks/register.tsx`: the plugin.
- `hooks/register.test.ts`: its tests.
- `routes.json`: all configuration.
- `routes.log.jsonl`: the last 200 decisions, shared by every session, which the
  pane reads. Git-ignored.
- `routes.spend.jsonl`: one line per routed turn, with tokens, for
  `/router savings`. Git-ignored and never trimmed.

## License

MIT. See [LICENSE](LICENSE).
