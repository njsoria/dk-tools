# Privacy

Last updated 13 October 2026.

Kore Model Router is a Claude Code plugin that runs on your machine. Kore LLC,
which publishes it, receives nothing from it: the plugin has no analytics, no
telemetry and no server of ours to call.

One thing leaves your machine, and only with the default classifier: the text
the classifier reads to sort a prompt.

## What is sent to TypeSafe

With `"classifier": "jev"` in `routes.json` (the default), each prompt that
needs classifying makes one request to TypeSafe's API,
`https://api.typesafe.ai/v1/systemone`. The request holds:

- **Your prompt**, up to 8,000 characters. A longer one is cut to its start and
  its end.
- **Up to the last four messages of the conversation**, yours and the
  assistant's, up to 600 characters each. They let a reply like "yes, go ahead"
  be judged by the job under way.
- **The task and effort descriptions** from `routes.json`.
- **Your TypeSafe API key**, as the request's authorization.

For a subagent, the request holds the subagent's description and its prompt in
place of yours, and no earlier messages. `/router <a prompt>` sends that prompt
the same way.

The plugin does not send your files, tool calls or tool results. Text you paste
into a prompt is part of the prompt, so it is sent.

No request is made when:

- a rule in `routes.json` decides the route,
- the prompt is a short follow-up or too short to classify,
- the router is off (`/router off`), or
- no TypeSafe key is set. The prompt then runs as your session set it.

TypeSafe handles what it receives under its own
[privacy policy](https://typesafe.ai/legal/privacy-policy). Kore LLC has no
access to it.

## Classifying without TypeSafe

Set `"classifier": "haiku"` in `routes.json`. The same text then goes to
Anthropic through the Claude Code login you already use, as your prompts do,
and nothing goes to TypeSafe. No key is needed.

## What is kept on your machine

Each session writes two files in the plugin's `logs/` folder:

- `<session id>.routes.jsonl`: each routing decision, with its time, the first
  2,000 characters of the prompt (120 for a subagent's task), the model and
  effort you had selected, the ones the router chose, the reason, and how long
  routing took.
- `<session id>.spend.jsonl`: one line per routed turn, with the same labels
  and the turn's token counts.

The pane and `/router savings` read these files. The plugin never sends them
anywhere and never trims them. Delete `logs/` whenever you like; you lose the
pane's history and the savings figures, nothing else.

Your TypeSafe key is read from the environment or from a `.env` file beside
`routes.json`. It is used only to authorize requests to TypeSafe and is never
written to a log.

## The accuracy eval

`eval/run.ts` is a development tool that runs only when you start it by hand.
It sends the sample prompts in `eval/cases.json` to TypeSafe, not your
conversations.

## Questions and changes

Open an issue at <https://github.com/njsoria/dk-tools/issues>. A change to what
the plugin sends or keeps is made in this file in the same release.
