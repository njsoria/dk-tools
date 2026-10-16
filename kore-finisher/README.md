# Kore Finisher

A Claude Code plugin that lists what you still have outstanding across your
sessions: the sessions stopped waiting on you, and the pull requests they
created or worked on.

## Install

```bash
/plugin marketplace add njsoria/dk-tools
/plugin install kore-finisher@dk-tools
```

## Commands

| Command | What it does |
| --- | --- |
| `/outstanding` | Lists what is outstanding, split into the desktop app's sessions and the terminal's and editors' |

Each group lists its items oldest first:

```
Outstanding: 3

Desktop app (2)
  ● web · 5m · asked a question
      Which database?
  ○ acme/web #3 · ready for review · updated 10m ago · this session
      Add login
      https://github.com/acme/web/pull/3

Terminal and editors (1)
  ○ acme/api #9 · draft · updated 30m ago
      Rate limits
      https://github.com/acme/api/pull/9
```

`●` is a session waiting on you; `○` is a pull request. A group with nothing
outstanding still shows, as "nothing outstanding".

## What counts

- **Waiting:** a permission prompt, an input request from an MCP server, the
  question dialog, or a turn that ends on a question. It clears when you send a
  prompt, when the session makes its next request, or when it ends. A wait with
  no update for 12 hours is dropped, since a killed session never says it ended.
- **Pull requests:** every open PR GitHub says you authored
  (`gh search prs --author @me --state open`, up to 50), so none is missed and
  a merged or closed one drops off. `gh` has to be installed and signed in; if
  it can't be reached the list says so and still shows the waiting sessions.
  Which group a PR goes in comes from what sessions recorded: a `gh pr` command
  other than `list` or `status`, or the desktop app's PR binding (`bind_pr`,
  `set_monitor`, `set_auto_merge`). A PR no session recorded, such as one opened
  before the plugin ran, is listed under "Not from a recorded session".

## Files

- `hooks/register.ts`: the plugin.
- `hooks/register.test.ts`: its tests.
- `logs/<session id>.waiting.json`: whether one session is waiting on you.
- `logs/<session id>.prs.json`: the pull requests one session touched.

Each session writes only its own files, so sessions running side by side can't
overwrite each other. `logs/` is git-ignored.

## Later

This is where a check on what blocks what, and in what order to finish, will go.

## License

MIT. See [LICENSE](LICENSE).
