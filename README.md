# DK.Tools

Small tools for day-to-day work at DevKore. Each folder stands alone.

The new-tab dashboard, Kore Bridge and Kore Catch-up moved to their own repo,
DK.kDash (`~/dev/DK.kDash`).

## Branching

```text
nate/feature/* ──┐
nate/fix/*     ──┼──► develop ──► main (synced by GitHub Actions)
nate/bug/*     ──┘
```

| Branch | Role |
| --- | --- |
| `develop` | **GitHub default**, the working branch |
| `main` | Mirror of `develop`, fast-forwarded on every push or merged PR |
| `nate/feature/*` | New work, branched from `develop` |
| `nate/fix/*` | Bug fixes, branched from `develop` |
| `nate/bug/*` | Defect fixes, branched from `develop` |

1. Branch from `develop`: `git checkout develop && git pull && git checkout -b nate/feature/my-work`
2. Commit using [Conventional Commits](https://www.conventionalcommits.org/).
3. Open a PR into `develop` (never directly to `main`).
4. `.github/workflows/sync-main.yml` then moves `main` to the same commit.
