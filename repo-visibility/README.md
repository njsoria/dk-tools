# repoVis

Shows on the line under the prompt whether the repo you are in is
public (🌐), private (🔒) or internal (🏢) on GitHub, with its
`owner/name`. It shows nothing outside a GitHub repo.

In the desktop app the footer under the input bar is narrow, so it shows the
visibility alone (`🌐 public`).

It runs `gh repo view --json nameWithOwner,visibility` in the session's folder
at session start and on each prompt, at most once every ten minutes per folder.
It needs the GitHub CLI signed in (`gh auth status`). Nothing is sent anywhere
but to GitHub, through `gh`.

Install: `/plugin install repoVis --marketplace njsoria/dk-tools`
