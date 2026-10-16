# Netlify usage

A command that tracks a Netlify team's credits on the credit-based plans,
lists the pain spots with a ready-to-run agent brief for each, and says, site
by site, when moving to Azure or AWS would cost less than staying.

It reads the Netlify API with the login the Netlify CLI already has, saves a
snapshot each run, and prints:

- the credit balance, the daily burn and the day the credits run out
- this period's bill and what a month costs at the current pace
- credits by meter: database compute, deploys, functions, requests, bandwidth
- pain spots, ranked high, medium and low
- each site's production deploys and credits, what moving it would save, the
  cheapest alternative and a verdict: MOVE, WATCH or STAY

## Run it

Node 22 or later and a Netlify CLI login (`netlify login`), or a personal
access token in `NETLIFY_AUTH_TOKEN`. No packages to install.

```bash
node netlify-usage/bin/netlify-usage.mjs
```

| Command | What it does |
| --- | --- |
| `netlify-usage` | Fetch usage, save a snapshot, print the report |
| `netlify-usage brief <n>` | Print pain spot `n`'s agent brief, from the last snapshot |
| `netlify-usage history` | One line per day a snapshot was taken |

Add `--team <slug>` for a team other than your default, `--json` for the
snapshot and analysis as JSON (what a dashboard reads), and `--no-save` to
leave the history alone.

## Where the numbers come from

| Data | Source |
| --- | --- |
| Credit balance, plan and packs | `/{team}/billing/credits` |
| Credits by meter this period | `/{team}/billing/credit_usage` |
| Credits by meter per day, 90 days | `/{team}/credit_usage_insights` |
| Production deploys and build time per site | The public deploys API |
| Database size and sleep setting per site | `/sites/{id}/database/compute/settings` |
| Whether each production database is awake, and its branch count | `/sites/{id}/database/branches` |

All but the deploys are the endpoints Netlify's own dashboard calls. They are
not in the public API reference, so they may change. If the billing ones stop
answering, the report falls back to counting production deploys and says so.

The branches route also returns connection strings. The tool keeps three
fields from it (branch count, awake, last active) and drops the rest before
anything is saved or printed. It never calls a site's `/database` route.

Netlify doesn't say which database the compute is for. A snapshot taken at a
quiet hour does: the database still awake then is the one that never sleeps.

## How it decides

Each meter's pace is its average over the last seven complete days, so it
follows what is running now. The run-out day is the balance divided by that
pace.

Netlify splits deploys by site but not database, function or request use. A
site's credits are its production deploys, projected for a month. Its
**saves** figure is those credits at the pack price, counted only past the
plan, since moving a site can't lower the plan price. For a site with a
database the real saving is higher by its share of database compute, and the
move needs somewhere to host the database.

The **cheapest** alternative is Azure Static Web Apps Free for a static site,
Standard ($9 an app) when it has functions or a database, or AWS Amplify
Hosting at $0.01 a build minute, previews included, plus Lambda for functions.
Prices and their sources are in `pricing.json`, with the date they were
checked.

A move costs time the numbers can't see, so a saving has to clear a bar
before the verdict says MOVE: $20 a month by default.

- **MOVE**: the saving clears the bar now and would have last period too.
- **WATCH**: it clears the bar now but not last period, or the site is a
  quarter or more of a plan that is over 80% used.
- **STAY**: anything less.

## Pain spots

| Spot | When |
| --- | --- |
| Credits run out | The balance runs out before the period ends. High when that is within a week or auto top-up is off |
| Database compute | Database compute is 15% or more of the plan a month. Says how many minimum-size databases that equals awake all day |
| Production deploys | A site's deploys are 15% or more of the plan a month |
| Move | A site's verdict is MOVE |
| Monthly cost | A month at this pace costs more than the plan |

High means 30% or more of the plan's credits a month, medium 15%. Each spot
has a `key` that stays the same from run to run (`database-compute`,
`deploys:<site>`). A spot that needs work has a brief: a prompt that states
the numbers, the sites and the question, so an agent can start on it with
nothing else.

`sampleDatabases()` in `lib/netlify.mjs` checks only whether each production
database is awake. Called every few minutes by a server, its samples set
`database.awakeShare` on a snapshot, and the database spot then names the
database that never sleeps.

## Notes the API can't know

Some reasons to move aren't about cost: a job that runs longer than Netlify's
function limits, a long-lived connection, a network or compliance rule. Others
keep a site where it is. Put them in `~/.config/netlify-usage/config.json` and
they override the numbers:

```json
{
  "minMonthlySaving": 20,
  "sites": {
    "example-app": { "blocker": "needs a worker that runs for an hour" },
    "example-site": { "pin": "the client's contract names Netlify" }
  }
}
```

The history lives in `~/.local/share/netlify-usage/history.jsonl`
(`$XDG_DATA_HOME` and `$XDG_CONFIG_HOME` move both files). Neither leaves the
machine.

## Test

```bash
cd netlify-usage && npm test
```
