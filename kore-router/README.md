<img src="assets/logo.svg" alt="Kore Router" width="96" height="96" align="left">

# Kore Router

A Claude Code plugin that sends each prompt, and each subagent, to the model
and effort its job deserves. Leave your session on your strongest model and
stop paying for it on small jobs, without risking the big ones.

<br clear="left">

For every prompt you type and every subagent the session starts, the router
picks a model (Haiku, Sonnet or Opus) and an effort level and applies them to
that turn's requests. Your session's own setting is untouched, and
`/router off` hands it straight back.

It runs in the Claude Code CLI and the desktop app, and was built and tested
on Claude Code 2.1.285. Its pane draws with elements every Claude Code surface
has, so the IDE extensions should show it too, though that is untested.

## Install

```bash
/plugin marketplace add njsoria/dk-tools
/plugin install kore-router@dk-tools
```

Then start a new session. The router says it is on with a toast, `router: on`
appears in the line under the prompt. Open its pane with `/router pane` or by
clicking that line (set `"openPane": true` in `routes.json` to open it with
every session).

To classify with Jev (the default), add a TypeSafe API key, either to the
environment or to a `.env` file beside `routes.json`:

```bash
TYPESAFE_API_KEY=...
```

Without a key, set `"classifier": "haiku"` in `routes.json` to classify on
your own Claude login instead.

To run a copy you are working on, point Claude Code at its folder:

```bash
claude --plugin-dir path/to/kore-router
```

## How it picks

1. **Rules first.** Each entry in `rules` is a regular expression, tried
   case-insensitively. A plain rule decides the route with no classifier call:
   `ultrathink` goes to Opus at max effort, and `typo`, `rename` or `format` at
   the start of a prompt is a `mechanical` task. A rule marked `atLeast` only
   raises what the classifier answers: anything that mentions security,
   secrets, auth, payments or charges, migrations, production, deploys or
   concurrency never runs below Opus at high effort.
2. **A short follow-up keeps the route in force.** "yes", "go ahead",
   "continue" and the like carry on the job under way, so no classifier call
   is made. So does a prompt of two words or fewer with no question mark
   (`guards.shortWords`), which is too thin to classify; an `atLeast` rule
   still raises it.
3. **Otherwise a classifier names the task.** It reads the prompt and the last
   few lines of the conversation (so "ok, do it" is judged by the job under
   way) against the `when` of each task: `answer`, `lookup`, `mechanical`,
   `build`, `review`, `debug`, `design` or `risky`. Each task has the least
   model and effort it runs on, and the classifier's effort can raise that,
   never lower it.
   - **Jev** (the default) is TypeSafe's classifier. It answers in about
     0.2 seconds (p95 under 0.3s), and at about $0.042 per million input
     tokens a routed prompt costs a few thousandths of a cent.
   - **Haiku** (`"classifier": "haiku"`) runs on your own Claude login, so it
     needs no key. It is slower: a full model call per prompt.
4. **Unsure means more capable.** Below `minConfidence`, the router takes
   whichever of the two likeliest tasks runs on the stronger model, and rounds
   the effort up.

The harness's own `<system-reminder>` notes are stripped first, so they
neither trip a rule nor sway the classifier.

### Why classify at all

The classifier is how the router tells "what does `git stash pop` do?" (Haiku,
low effort) from "the checkout test fails one run in ten" (Opus, high effort).
Rules alone catch only the obvious cases, and without a route every prompt
runs on whatever the session has selected. The cost is a short wait before the
turn starts: the classifier's answer, plus a few milliseconds of rules. The
router keeps the last lines of the conversation in memory rather than reading
the transcript each time, and gives up after `timeoutMs` (2 seconds), leaving
the route in force. Each decision logs `classifyMs` and `routeMs`, and the
pane shows both, so you can see what routing costs in your own sessions.

## Subagents

When the session starts a subagent, the router picks its model too:

- A type listed under `subagents.types` gets its task with no classifier call
  (`Explore` is a `lookup`, `Plan` is a `design`).
- Any other type is classified on its own description and prompt, without the
  main conversation.
- If the Agent call named a model, it is kept when it is at least as strong as
  the task's, and raised to the task's when it is weaker.
- The subagent's requests then take the task's effort.

Forks (which must share their parent's model), teammates and a workflow's
agents are left alone. A subagent starts with an empty cache, so moving it to
a cheaper model costs nothing: this is where routing saves the most.

## Quality guards

The router raises a turn when in doubt and never lowers one:

- **Task floors.** A task never runs below its own model and effort, and an
  `atLeast` rule raises any task whose words mark it risky.
- **Pushback escalates.** A prompt that matches `guards.pushback` ("that's
  wrong", "still failing", "no, the other one"...) runs a tier above the turn it
  answers, and so do the next `holdTurns - 1` prompts. At the top tier it
  thinks a level harder instead. Blunt openers ("no", "wrong", "revert") count
  only at the start of the prompt. Softer corrections and frustration ("I'm
  talking about...", "I said...", "I meant...", "I don't need you to...",
  "it still doesn't work", "that's wrong") count at the start of any sentence
  or line, after at most two interjections ("ok,", "sorry,", "try again,"), so
  they are caught after a first sentence too. A few phrases ("you're confusing
  me", "as I said", "do what I'm saying") count anywhere. An instruction like
  "I need you to add a flag" is not a correction and does not escalate, and
  neither does a bare "try again" or "check again", which may only mean refresh
  a report or re-run a search.
- **A struggling turn moves up.** After `guards.toolErrors` failed tool calls
  in one turn below the top model, the rest of the turn runs a tier up, and the
  floor holds for the next few prompts.
- **Context limits.** A model's `maxContext` is the most conversation it is
  trusted with. Past it (Haiku's is 100K tokens, where its price also rises
  fivefold) the router keeps a stronger model, whatever the task.
- **Your own floor.** `/router floor sonnet` keeps the session at Sonnet or
  above until `/router floor off`. An escalation running out doesn't lift it.
- **Failures fall back.** If routing fails for any reason (no key, a timeout, a
  mistake in `routes.json`), the prompt runs on the route already in force, or
  as the session set it. The router is never the reason a prompt fails.

Every escalation, floor and hold is logged with its reason and shown in the
pane.

## Stepping down

Caches are kept per model. Switching to a cheaper model makes it write the
whole conversation into its own cache, and switching back may make the
stronger one write it again. The router steps down only when the turn saves at
least `switching.margin` (1.5) times what the switch costs, worked out from:

- the size of the last request (the conversation the switch rewrites),
- the prices in `routes.json`, including Haiku's dearer rates above 100K,
- this session's median requests and output tokens per turn
  (`expectedSteps` and `expectedOutput` until there are turns to measure),
- whether the stronger model's cache will still be warm on the way back: two
  of the session's median gaps between prompts against `cacheTtlMinutes`.

At current prices a step from Opus to Haiku pays at almost any length under
100K. A step from Opus to Sonnet almost never pays once there is a
conversation, since Sonnet 5.5's cache reads cost the same as Opus 5.5's: the
router keeps Opus and still lowers the effort. Changing effort alone doesn't
rewrite the cache.

A model not in `pricing` falls back to a plain rule: no step down past
`fallbackMessages` (30) messages.

A turn keeps the route it began on, so a prompt typed mid-turn doesn't switch
models under it. The one exception is a struggling turn, as above.

## The pane

The pane lists this session's last 30 decisions, newest first, one line each:
the time, the model and effort the turn ran on, and marks for a subagent, a
hold or a guard that changed the route (`*`). A collapsed row shows the first line of the prompt. Click a line (or focus it
and press Enter) to open it and see everything the router logged for it: the full
prompt, what the classifier asked for, what ran, why, what the session had
selected, the message count and how long routing took. **Open all** and
**Close all** do every row at once.

The line under the prompt shows the route in force (`router: sonnet · medium`,
with the reason when a guard changed it). Click it to open the pane, or run
`/router pane`. That line is drawn in the CLI and the desktop app; other
surfaces don't draw it yet.

## Commands

| Command | What it does |
| --- | --- |
| `/router` | Shows whether the router is on, the last route and any floor |
| `/router on`, `/router off` | Turn it on, or hand the session back to its own model |
| `/router pane`, `/router open` | Open the pane |
| `/router floor <model>` | Never run below this model until `/router floor off` |
| `/router floor off` | Lift your floor and any escalation |
| `/router savings` | Price what the router saved against your baseline model |
| `/router savings sonnet` | The same, against another model from `routes.json` |
| `/router savings session` | Against whatever model you had selected for each turn |
| `/router <a prompt>` | Show the route a prompt would get, without sending it |

## Savings

Each routed turn, yours or a subagent's, adds a line to its session's spend
file with the model you (or the subagent's parent) had selected, the model the
router ran and the turn's token counts. `/router savings` prices those same
tokens on both models, reports the difference, and breaks it down by the model
that ran.

The baseline defaults to `{ "model": "opus", "effort": "xhigh" }`. Prices sit
beside it in `routes.json`, in dollars per million tokens. Cache writes are
priced at the 1-hour rate (2x input), which Claude Code sessions use. Check the
prices against Anthropic's current pricing.

What the figure leaves out:

- It prices the model, not the effort, and uses the same tokens on both sides.
  A lower effort also thinks less, so the real saving is probably somewhat
  larger.
- The classifier's own cost isn't counted.
- It prices a turn's tokens at one rate, so Haiku's dearer rate above 100K
  isn't applied.
- A turn that moved up a tier partway is priced wholly on the stronger model.

## Accuracy

`eval/cases.json` holds 60 labelled prompts. The first 44 are plain, everyday
asks. The last 16 are deliberately hard: debugging phrased as a question,
risky work phrased as a quick fix, pasted stack traces, two jobs in one
prompt, and bare follow-ups like "make it faster". `eval/run.ts` sends each
through the same code the plugin runs before a turn (rules, classifier, task
floors) and scores the model it lands on:

```bash
npx -y tsx@4.19.2 eval/run.ts --runs 5
```

Latest result with Jev, 60 cases × 5 runs:

| Measure | Result |
| --- | --- |
| Right model | 100% (plain 100%, hard 100%) |
| Under-routed (the quality risk) | 0% |
| Over-routed (the cost) | 0% |
| Right task | 98% (92% the exact label) |
| Same route on every run | 98% |
| Latency | p50 167 ms, p95 236 ms |

Treat these as a floor test, not a promise. The cases were written alongside
the routing rules, and one round of tuning (adding charges and refunds to the
risky words) came from a miss this suite found. Real prompts are messier.
When the pane shows a misroute, add it to `cases.json` with the task it should
have had, and fix `routes.json` until the suite passes again.

The eval needs `TYPESAFE_API_KEY` and makes one Jev call per case per run. It
writes every answer to `eval/results/`, which git ignores.

The pushback guard has its own offline check, with no key or API call. It tests
`guards.pushback` against the corrections and near-misses under `pushback` in
`cases.json` and exits non-zero on a miss:

```bash
npx -y tsx@4.19.2 eval/pushback.ts
```

## Configuration

All of it is in [`routes.json`](routes.json).

| Key | Meaning |
| --- | --- |
| `classifier` | `jev` or `haiku` |
| `minConfidence` | Below this, take the more capable choice (0 to 1) |
| `timeoutMs` | How long to wait for the classifier |
| `openPane` | Open the pane when a session starts (`true`), or leave it to `/router pane` |
| `baseline` | What `/router savings` compares against by default |
| `pricing` | Dollars per million tokens, by model id, with an optional `longContext` rate above a token count |
| `switching` | `expectedSteps`, `expectedOutput`, `cacheTtlMinutes`, `margin`, `fallbackMessages`: when a step down pays |
| `guards` | `pushback` and `followUp` (regexes), `shortWords`, `holdTurns`, `toolErrors` |
| `subagents` | `classify` (other types), and `types`: agent type to task |
| `rules` | `match` (regex), then a `task` or a `model` and `effort`, a `why`, and `atLeast` to raise rather than decide |
| `tasks` | `name`, the least `model` and `effort` it runs on, and a `when` the classifier reads |
| `models` | `name`, `id`, optional `maxContext`. Order them weakest to strongest |
| `efforts` | Levels, weakest to strongest, each with a `when` |

The `when` of each task is the router's whole idea of your work. Edit it to
describe the jobs you'd send to each model, then run the eval. A mistake in
`routes.json` (a task naming a model that isn't listed, say) is caught when the
file is read, and the prompt runs as the session set it.

## Development

```bash
claude plugin test kore-router
```

runs `hooks/register.test.ts`, 36 tests that read as the router's
specification: each test name states one behaviour, from "a rule routes
without asking the classifier" to "a step down that wouldn't pay for its
cache keeps the model". They run against a mocked engine, with no network and
no model calls.

The CLI and the desktop app each carry their own copy of the engine, and the
two are not always the same version: the desktop app's can offer hook fields
the CLI's does not have yet (`agent.spawn`'s `isTeammate` and `workflow`, for
example). Keep the CLI current (`brew upgrade --cask claude-code`, or
`claude update`), and write against fields every supported version has, or
read the newer ones defensively, as `register.tsx` does. Claude Code writes the
API types of the engine that last loaded the plugin into
`.claude-plugin/types/`, so type-check after running it in each.

Claude Code's plugin host follows `$`, the engine handle, only into functions
declared in the hooks module itself. So everything that touches the engine
lives in `register.tsx`, and the decisions are pure functions in the modules
beside it.

## Files

- `hooks/register.tsx`: the hooks, and everything that touches the engine.
- `hooks/decide.ts`: rules, floors, escalation and the step-down sum.
- `hooks/classify.ts`: what Jev and Haiku are asked, and how their answers are read.
- `hooks/config.ts`: the types of `routes.json`, and its check.
- `hooks/ledger.ts`: the log lines, and `/router savings`.
- `hooks/pane.ts`: what the pane says about each decision.
- `hooks/register.test.ts`: the tests.
- `eval/`: the labelled prompts and the accuracy runner.
- `routes.json`: all configuration.
- `logs/<session id>.routes.jsonl`: every decision of one session, which its
  pane reads.
- `logs/<session id>.spend.jsonl`: one line per routed turn of one session,
  with tokens. `/router savings` adds up every session's file.

Each session writes only its own files, so sessions running side by side can't
overwrite each other. `logs/` is git-ignored and never trimmed. A
`routes.spend.jsonl` left by an earlier version is still counted.

## License

MIT. See [LICENSE](LICENSE).
