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
  ○ acme/web #3 · open · touched 10m ago · this session
      Add login
      https://github.com/acme/web/pull/3

Terminal and editors (1)
  ○ acme/api #9 · draft · touched 30m ago
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
- **Pull requests:** a `gh pr` command other than `list` or `status` whose
  input or output names a PR, and the desktop app's PR binding
  (`bind_pr`, `set_monitor`, `set_auto_merge`). A PR is listed until `gh`
  reports it merged or closed. If `gh` can't be reached, the PR is listed as
  "state unknown".

Pull requests are recorded only from the calls above. A PR made any other way
doesn't appear.

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
