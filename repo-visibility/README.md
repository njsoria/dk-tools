# repoVis

Shows, as its own status line under the prompt, whether the repo you are in
is public (🌐), private (🔒) or internal (🏢) on GitHub, with its
`owner/name`: `🌐 public · njsoria/dk-tools`. It shows nothing outside a
GitHub repo, and keeps the last answer when a check fails.

It uses the status line rather than the desktop app's mode labels, which are
one short label that kore-model-router's line already fills.

It runs `gh repo view --json nameWithOwner,visibility` in the session's folder
at session start and on each prompt, at most once every ten minutes per folder.
It needs the GitHub CLI signed in (`gh auth status`). Nothing is sent anywhere
but to GitHub, through `gh`.

Install: `/plugin install repoVis --marketplace njsoria/dk-tools`
