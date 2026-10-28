# DK.Tools

Small tools for day-to-day work at DevKore. Each folder stands alone.

## Tools

| Tool | What it is |
| --- | --- |
| [Webhook Monitor](webhook-monitor) | A Railway service that gives a webhook an address to post to and shows each request live, timed in milliseconds from a click of yours, to measure a sender's delay |
| [Kore Model Router](kore-router) | A Claude Code plugin that sends each prompt and each subagent to the model and effort its job deserves, with guards that raise a turn when quality is at risk |
| [Netlify usage](netlify-usage) | A command that tracks a Netlify team's credits, ranks the pain spots with an agent brief for each, and says which sites would cost less on Azure or AWS |
| [YouTube transcript](yt-transcript) | A command that gets a YouTube video's transcript as timestamped markdown, text, SRT or JSON, ready to hand to an agent to pull out what is worth adopting |

The repository is also a Claude Code plugin marketplace:

```bash
/plugin marketplace add njsoria/dk-tools
/plugin install kore-model-router@dk-tools
```

## Contributing

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

## License

MIT. See [LICENSE](LICENSE).
