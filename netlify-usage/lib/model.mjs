const DAY = 86_400_000
const MONTH_DAYS = 30.4
// Neon, which runs Netlify Database, gives each compute unit 4 GB of memory.
const GB_PER_CU = 4

export const METERS = {
  db_compute: 'Database compute',
  production_deploys: 'Production deploys',
  functions_compute: 'Functions compute',
  web_requests: 'Web requests',
  bandwidth: 'Bandwidth',
  db_bandwidth: 'Database bandwidth',
  dev_server_compute: 'Preview servers',
  ai_gateway_ai_inference: 'AI inference',
  agent_runner_compute: 'Agent Runners compute',
  agent_runner_ai_inference: 'Agent Runners AI',
}

export function period(snap, now) {
  const start = Date.parse(snap.period.start)
  const end = Date.parse(snap.period.end)
  const days = (end - start) / DAY
  const t = Math.min(Math.max(now, start), end)
  // Half a day minimum, so the first hours of a period don't divide by ~0.
  const elapsed = Math.min(Math.max((t - start) / DAY, 0.5), days)
  return { start, end, days, elapsed, remaining: days - elapsed }
}

// Straight-line pace once a week of the period has passed. Before that, a few
// deploys would swing the projection wildly, so last period's pace fills in.
export function project(current, last, p) {
  const rate = p.elapsed >= 7 || last == null ? current / p.elapsed : (current + last) / (p.elapsed + p.days)
  return current + rate * p.remaining
}

const packPrice = (plan) => plan.packCredits * plan.creditPrice

// A month at a steady pace: the plan, plus every credit past it at the pack
// price. Packs never expire, so over months a credit is what gets paid for.
export function monthlyBill(credits, plan) {
  const over = Math.max(0, credits - plan.includedCredits)
  const packs = plan.packCredits > 0 ? Math.ceil(over / plan.packCredits) : 0
  return { credits, packs, total: plan.base + over * plan.creditPrice }
}

function meterTotals(snap, perDeploy) {
  if (snap.billing) return snap.billing.meters
  return { production_deploys: sum(snap.sites.map((s) => s.current), 'production') * perDeploy }
}

// Each meter's daily pace is the last seven complete days, so it reflects what
// is running now rather than how the period started.
export function dailyRates(snap, p, totals) {
  const days = (snap.billing?.daily || []).slice(-7)
  const ids = new Set([...Object.keys(totals), ...days.flatMap((d) => Object.keys(d.credits))])
  const out = {}
  for (const id of ids)
    out[id] = days.length >= 3 ? days.reduce((t, d) => t + (d.credits[id] || 0), 0) / days.length : (totals[id] || 0) / p.elapsed
  return out
}

function lastPeriodCredits(snap, p) {
  const daily = snap.billing?.daily || []
  const lastStart = new Date(p.start)
  lastStart.setMonth(lastStart.getMonth() - 1)
  // A date's noon UTC falls inside that day in any US time zone.
  const inLast = daily.filter((d) => {
    const t = Date.parse(`${d.date}T12:00:00Z`)
    return t >= lastStart.getTime() && t < p.start
  })
  if (inLast.length < 20) return null
  return inLast.reduce((t, d) => t + Object.values(d.credits).reduce((a, b) => a + b, 0), 0)
}

function alternatives(site, pricing) {
  const az = pricing.azureStaticWebApps
  const aws = pricing.awsAmplify
  const needsStandard = site.functions > 0 || site.database
  return [
    {
      name: needsStandard ? 'Azure SWA Standard' : 'Azure SWA Free',
      cost: needsStandard ? az.standardPerAppMonth : az.freePerAppMonth,
    },
    { name: site.functions > 0 ? 'AWS Amplify + Lambda' : 'AWS Amplify', cost: site.buildMinutes * aws.buildMinute },
  ].sort((a, b) => a.cost - b.cost)
}

export function analyze(snap, { config = { sites: {} }, pricing, now = Date.now() }) {
  const p = period(snap, now)
  const plan = snap.plan
  const perDeploy = pricing.netlify.creditsPerProductionDeploy
  const totals = meterTotals(snap, perDeploy)
  const rate = dailyRates(snap, p, totals)

  const meters = Object.keys({ ...totals, ...rate })
    .map((id) => {
      const used = totals[id] || 0
      const perDay = rate[id] || 0
      return { id, label: METERS[id] || id, now: used, perDay, projected: used + perDay * p.remaining, monthly: perDay * MONTH_DAYS }
    })
    .filter((m) => m.now >= 0.5 || m.perDay >= 0.5)
    .sort((a, b) => b.monthly - a.monthly)
  const perDay = sum(meters, 'perDay')
  const monthly = perDay * MONTH_DAYS
  for (const m of meters) m.share = monthly ? m.monthly / monthly : 0

  const used = sum(meters, 'now')
  const available = snap.billing
    ? snap.billing.plan.available + snap.billing.packs.available
    : Math.max(0, plan.includedCredits - used)
  const daysLeft = perDay > 0 ? available / perDay : Infinity
  const runOut = daysLeft < p.remaining ? now + daysLeft * DAY : null
  const shortfall = Math.max(0, perDay * p.remaining - available)
  const morePacks = plan.autoTopup && plan.packCredits ? Math.ceil(shortfall / plan.packCredits) : 0
  const bought = (snap.billing?.blocks || []).filter((b) => b.pack && Date.parse(b.start) >= p.start).length
  const thisPeriod = { bought, morePacks, total: plan.base + (bought + morePacks) * packPrice(plan) }
  const steady = monthlyBill(monthly, plan)
  const lastTotal = lastPeriodCredits(snap, p)

  const sites = snap.sites.map((s) => {
    const deploys = (project(s.current.production, s.last.production, p) / p.days) * MONTH_DAYS
    return {
      ...s,
      deploysPerDay: s.current.production / p.elapsed,
      deploys,
      credits: deploys * perDeploy,
      buildMinutes: (project(s.current.buildMinutes, s.last.buildMinutes, p) / p.days) * MONTH_DAYS,
    }
  })
  for (const s of sites) {
    s.share = monthly ? s.credits / monthly : 0
    s.saves = steady.total - monthlyBill(monthly - s.credits, plan).total
    s.savedLast =
      lastTotal == null
        ? s.saves
        : monthlyBill(lastTotal, plan).total - monthlyBill(lastTotal - s.last.production * perDeploy, plan).total
    s.alternatives = alternatives(s, pricing)
    s.net = s.saves - s.alternatives[0].cost
    Object.assign(s, verdict(s, config.sites?.[s.name] || {}, { monthly, plan, bar: config.minMonthlySaving ?? 20 }))
  }
  sites.sort((a, b) => b.credits - a.credits)

  const movers = sites.filter((s) => s.verdict === 'MOVE')
  let moveAll = null
  if (movers.length) {
    const after = movers.length === sites.length ? 0 : monthlyBill(monthly - sum(movers, 'credits'), plan).total
    const altCost = movers.reduce((t, s) => t + s.alternatives[0].cost, 0)
    moveAll = { names: movers.map((s) => s.name), before: steady.total, after, altCost, net: steady.total - after - altCost }
  }

  const a = { period: p, plan, meters, perDay, monthly, used, available, runOut, thisPeriod, steady, lastTotal, sites, moveAll, estimated: !snap.billing }
  a.painSpots = painSpots(snap, a, { perDeploy, now })
  return a
}

// A move has a one-time cost the numbers can't see, so a saving has to clear a
// bar (config minMonthlySaving, $20 by default) before it says MOVE.
function verdict(s, cfg, { monthly, plan, bar }) {
  if (cfg.blocker) return { verdict: 'MOVE', reason: cfg.blocker }
  if (cfg.pin) return { verdict: 'STAY', reason: cfg.pin }
  const alt = s.alternatives[0]
  const lastNet = s.savedLast - alt.cost
  const more = s.database ? ', more with its share of database compute, less the cost of hosting its database' : ''
  if (s.net >= bar && lastNet >= bar)
    return { verdict: 'MOVE', reason: `${alt.name} saves at least ${usd(s.net)} a month${more}, and would have last period too` }
  if (s.net >= bar) return { verdict: 'WATCH', reason: `${alt.name} would save ${usd(s.net)} a month at this pace${more}, but not last period` }
  if (monthly > 0.8 * plan.includedCredits && s.share >= 0.25)
    return { verdict: 'WATCH', reason: `${pct(s.share)} of the team's credits` }
  return {
    verdict: 'STAY',
    reason:
      s.net >= 1
        ? `${alt.name} would save ${usd(s.net)} a month${more}, under the ${usd(bar)} bar for a move`
        : `moving saves nothing at this usage${more}`,
  }
}

const SEVERITY = { high: 0, medium: 1, low: 2 }

// Each pain spot carries a key that stays the same from run to run, and a
// brief: a prompt that can start an agent on it without this report beside it.
function painSpots(snap, a, { perDeploy, now }) {
  const { plan, period: p } = a
  const spots = []
  const team = `the Netlify team "${snap.team.slug}"`
  const cost = (credits) => usd(credits * plan.creditPrice)
  const severity = (monthly) => (monthly >= 0.3 * plan.includedCredits ? 'high' : monthly >= 0.15 * plan.includedCredits ? 'medium' : 'low')

  if (a.runOut) {
    const days = (a.runOut - now) / DAY
    const packs = a.thisPeriod.morePacks
    spots.push({
      severity: !plan.autoTopup || days < 7 ? 'high' : 'medium',
      key: 'run-out',
      title: `Credits run out around ${day(a.runOut)}`,
      detail: plan.autoTopup
        ? `${n(a.available)} left at ${n(a.perDay)} a day. Auto top-up will buy about ${packs} more ${packs === 1 ? 'pack' : 'packs'} (${usd(packs * packPrice(plan))}) before ${day(p.end)}.`
        : `${n(a.available)} left at ${n(a.perDay)} a day. Auto top-up is off, so every site on the team pauses then.`,
      credits: a.monthly,
      brief: null,
    })
  }

  const db = a.meters.find((m) => m.id === 'db_compute')
  const dbSites = a.sites.filter((s) => s.database)
  if (db && dbSites.length && db.monthly >= 0.15 * plan.includedCredits) {
    const days = (snap.billing?.daily || []).slice(-7)
    const gbHours = days.length ? days.reduce((t, d) => t + (d.usage?.db_compute || 0), 0) / days.length : null
    const minGB = Math.min(...dbSites.map((s) => (s.database.minCU ?? 0.25) * GB_PER_CU))
    const awake = gbHours != null ? gbHours / 24 / minGB : null
    // Samples taken through the day (database.awakeShare) name the database
    // that never sleeps. A single snapshot only says what it saw just then.
    const list = dbSites
      .map((s) => {
        const d = s.database
        const facts = [
          d.awakeShare != null
            ? `awake ${pct(d.awakeShare)} of ${d.awakeWindow}`
            : d.awake != null && (d.awake ? 'awake' : 'asleep') + ' at this snapshot',
          d.sleepSeconds && `sleeps after ${d.sleepSeconds}s idle`,
          d.branches > 1 && `${d.branches} branches`,
        ].filter(Boolean)
        return facts.length ? `${s.name} (${facts.join(', ')})` : s.name
      })
      .join(', ')
    const always = dbSites.filter((s) => (s.database.awakeShare ?? 0) >= 0.9).map((s) => s.name)
    const which = always.length
      ? ` Samples show ${always.join(' and ')} awake nearly all the time.`
      : " Netlify doesn't say which database."
    const size =
      awake != null
        ? ` That is ${gbHours.toFixed(0)} GB-hours a day, as much as ${awake < 1.5 ? 'one database' : `${awake.toFixed(1)} databases`} at minimum size awake around the clock.`
        : ''
    spots.push({
      severity: severity(db.monthly),
      key: 'database-compute',
      title: always.length
        ? `Database compute: ${always.join(' and ')} never ${always.length === 1 ? 'sleeps' : 'sleep'}, ${n(db.perDay)} credits a day`
        : `Database compute: ${n(db.perDay)} credits a day`,
      detail: `${pct(db.share)} of all credits, ${cost(db.monthly)} a month at the pack price.${size}${which} Sites with one: ${list}.`,
      credits: db.monthly,
      brief:
        `On ${team}, Netlify Database compute costs about ${n(db.perDay)} credits a day (${cost(db.monthly)} a month at the pack price), ` +
        `${pct(db.share)} of the team's credits.${size}${which} Sites with a database: ${list}. ` +
        (always.length
          ? `Find what keeps ${always.join(' and ')}'s database awake: `
          : 'Find which database stays awake and what keeps waking it: ') +
        'scheduled or background functions, polling, open connections, health checks. ' +
        'Then propose the change that lets it sleep. Production stays read-only until Nate approves a change.',
    })
  }

  for (const s of a.sites.filter((x) => x.credits >= 0.15 * plan.includedCredits)) {
    const where = s.repo ? ` (${s.repo.replace('https://github.com/', '')})` : ''
    spots.push({
      severity: severity(s.credits),
      key: `deploys:${s.name}`,
      title: `${s.name}: ${s.deploysPerDay.toFixed(1)} production deploys a day`,
      detail: `${n(s.credits)} credits a month at ${perDeploy} a deploy, ${cost(s.credits)} at the pack price. Deploy previews are free.`,
      credits: s.credits,
      brief:
        `The Netlify site ${s.name}${where} publishes about ${s.deploysPerDay.toFixed(1)} production deploys a day, ` +
        `${perDeploy} credits each, about ${n(s.credits)} credits (${cost(s.credits)}) a month. ` +
        'Find what triggers them and propose a way to publish less often without slowing fixes: batching merges to the production branch, ' +
        'an ignore rule in netlify.toml for changes that do not affect the site, or moving bot and scheduled commits off that branch.',
    })
  }

  for (const s of a.sites.filter((x) => x.verdict === 'MOVE')) {
    const where = s.repo ? ` (${s.repo.replace('https://github.com/', '')})` : ''
    const alt = s.alternatives[0]
    spots.push({
      severity: 'medium',
      key: `move:${s.name}`,
      title: `Move ${s.name} to ${alt.name}`,
      detail: `${s.reason}.`,
      credits: s.credits,
      brief:
        `Plan moving the Netlify site ${s.name}${where} to ${alt.name}. ${s.reason}. ` +
        `List what it uses on Netlify (${s.functions} functions${s.database ? ', a Netlify Database' : ''}, redirects, forms, environment variables), ` +
        `the equivalent on ${alt.name}, the DNS cutover, and the one-time effort in hours. Write the plan; change nothing.`,
    })
  }

  if (a.steady.packs > 0) {
    spots.push({
      severity: 'low',
      key: 'monthly-cost',
      title: `Netlify runs ${usd(a.steady.total)} a month at this pace`,
      detail: `${n(a.monthly)} credits a month against ${n(plan.includedCredits)} in the plan: ${usd(a.steady.total - plan.base)} of packs on top of ${usd(plan.base)}.`,
      credits: a.monthly,
      brief: null,
    })
  }

  return spots.sort((x, y) => SEVERITY[x.severity] - SEVERITY[y.severity] || y.credits - x.credits)
}

const sum = (rows, key) => rows.reduce((t, r) => t + r[key], 0)
export const n = (x) => Math.round(x).toLocaleString('en-US')
export const usd = (x, dp = 0) => `$${x.toFixed(dp)}`
export const pct = (x) => `${Math.round(x * 100)}%`
export const day = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
