import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const API = 'https://api.netlify.com/api/v1/'

// The CLI keeps its login here; reading it means no second token to manage.
function cliConfigPaths() {
  const home = os.homedir()
  return [
    path.join(home, 'Library/Preferences/netlify/config.json'),
    path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'netlify/config.json'),
  ]
}

export function readToken() {
  if (process.env.NETLIFY_AUTH_TOKEN) return process.env.NETLIFY_AUTH_TOKEN
  for (const file of cliConfigPaths()) {
    if (!fs.existsSync(file)) continue
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
    const token = cfg.users?.[cfg.userId]?.auth?.token
    if (token) return token
  }
  throw new Error('No Netlify token. Run `netlify login` or set NETLIFY_AUTH_TOKEN.')
}

export function client(token) {
  return async function get(route) {
    const res = await fetch(API + route, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`Netlify API ${res.status} on ${route.split('?')[0]}`)
    return res.json()
  }
}

async function deploysSince(get, siteId, since) {
  const out = []
  for (let page = 1; page < 50; page++) {
    const batch = await get(`sites/${siteId}/deploys?per_page=100&page=${page}`)
    out.push(...batch)
    if (batch.length < 100 || new Date(batch.at(-1).created_at) < since) break
  }
  return out.filter((d) => new Date(d.created_at) >= since)
}

function addMonths(date, n) {
  const d = new Date(date)
  d.setMonth(d.getMonth() + n)
  return d
}

// The credit balance, per-meter usage and daily series come from the
// endpoints Netlify's own Usage page calls. They are not in the public API
// reference and may change, so a failure falls back to counting deploys.
async function billing(get, slug) {
  try {
    const [credits, usage, daily] = await Promise.all([
      get(`${slug}/billing/credits`),
      get(`${slug}/billing/credit_usage`),
      get(`${slug}/credit_usage_insights`),
    ])
    return {
      plan: numbers(credits.plan_credits),
      packs: numbers(credits.credit_addons),
      blocks: (credits.active_credit_blocks || []).map((b) => ({
        balance: Number(b.balance),
        size: Number(b.maximum_initial_balance),
        start: b.effective_date,
        pack: !b.subscription_allocation && !b.grace_credit && !b.coupon_credit,
      })),
      meters: Object.fromEntries(Object.entries(usage).map(([id, v]) => [id, Number(v.credits_used)])),
      daily: daily.slice(-62).map((d) => ({
        date: d.date,
        credits: Object.fromEntries(d.usage.map((m) => [m.metric_id, m.credit_cost])),
        usage: Object.fromEntries(d.usage.map((m) => [m.metric_id, m.metric_usage])),
      })),
    }
  } catch {
    return null
  }
}

// The branches route returns each branch's connection strings too. Only the
// fields named here leave this function, so none reach the history or output.
async function databaseBranches(get, siteId) {
  try {
    const res = await get(`sites/${siteId}/database/branches`)
    const list = Array.isArray(res) ? res : res.branches || []
    const prod = list.find((b) => b.name === 'production')
    return {
      branches: list.length,
      awake: prod?.compute?.current_state === 'active',
      lastActive: prod?.compute?.last_active ?? null,
    }
  } catch {
    return {}
  }
}

const numbers = (o = {}) => ({ used: Number(o.used || 0), available: Number(o.available || 0), total: Number(o.total || 0) })

// A cheap check, made every few minutes: is each production database awake?
// Reading the branch list doesn't wake a database.
export async function sampleDatabases() {
  const get = client(readToken())
  const sites = await get('sites?filter=all&per_page=100')
  const withDb = sites.filter((s) => s.has_database)
  const states = await Promise.all(withDb.map((s) => databaseBranches(get, s.id)))
  return {
    at: new Date().toISOString(),
    databases: Object.fromEntries(withDb.map((s, i) => [s.name, states[i].awake ?? null])),
  }
}

export async function collect({ team } = {}) {
  const get = client(readToken())
  const accounts = await get('accounts')
  const account = team
    ? accounts.find((a) => a.slug === team)
    : accounts.find((a) => a.default) || accounts[0]
  if (!account) throw new Error(`No Netlify team ${team ? `"${team}"` : ''} on this login.`)

  const [bill, subscription, sites] = await Promise.all([
    billing(get, account.slug),
    get(`accounts/${account.id}/subscription`).catch(() => null),
    get(`sites?filter=all&per_page=100`),
  ])

  const periodStart = new Date(account.current_billing_period_start)
  const periodEnd = new Date(account.next_billing_period_start)
  const lastStart = addMonths(periodStart, -1)

  const ours = sites.filter((s) => s.account_id === account.id)
  const perSite = await Promise.all(
    ours.map(async (s) => {
      const [deploys, db, branches] = await Promise.all([
        deploysSince(get, s.id, lastStart),
        // Compute settings only: the site's /database route returns credentials.
        s.has_database ? get(`sites/${s.id}/database/compute/settings`).catch(() => null) : null,
        s.has_database ? databaseBranches(get, s.id) : null,
      ])
      const tally = (from, to) => {
        const inRange = deploys.filter((d) => {
          const t = new Date(d.created_at)
          return t >= from && t < to
        })
        const built = inRange.filter((d) => d.state === 'ready' || d.state === 'error')
        return {
          production: inRange.filter((d) => d.context === 'production' && d.state === 'ready').length,
          other: inRange.filter((d) => d.context !== 'production').length,
          buildMinutes: built.reduce((sum, d) => sum + (d.deploy_time || 0), 0) / 60,
        }
      }
      return {
        name: s.name,
        repo: s.build_settings?.repo_url || null,
        functions: s.published_deploy?.available_functions?.length ?? 0,
        database: s.has_database
          ? { minCU: db?.min_cu ?? null, maxCU: db?.max_cu ?? null, sleepSeconds: db?.sleep_timeout_seconds ?? null, ...branches }
          : null,
        current: tally(periodStart, periodEnd),
        last: tally(lastStart, periodStart),
      }
    }),
  )

  return {
    at: new Date().toISOString(),
    team: { slug: account.slug, name: account.name, planName: account.type_name },
    period: { start: periodStart.toISOString(), end: periodEnd.toISOString() },
    plan: {
      includedCredits: Number(account.plan_credits ?? account.capabilities?.credits?.included ?? 0),
      packCredits: Number(account.plan_auto_topup_amount || 0),
      creditPrice: Number(account.plan_auto_topup_per_unit_cost || 0),
      autoTopup: Boolean(account.auto_topup_enabled),
      base: Number(subscription?.amount ?? account.member_monthly_dollar_price ?? 0),
    },
    billing: bill,
    sites: perSite,
  }
}
