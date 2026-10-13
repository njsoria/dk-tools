import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { analyze, monthlyBill, period, project } from '../lib/model.mjs'

const pricing = JSON.parse(fs.readFileSync(new URL('../pricing.json', import.meta.url), 'utf8'))
const DAY = 86_400_000
const start = Date.parse('2026-10-01T00:00:00Z')
const now = start + 15 * DAY
const plan = { includedCredits: 5000, packCredits: 1500, creditPrice: 10 / 1500, autoTopup: true, base: 20 }

function site(name, production, last, extra = {}) {
  return {
    name,
    repo: null,
    functions: 0,
    database: null,
    current: { production, other: 0, buildMinutes: production },
    last: { production: last, other: 0, buildMinutes: last },
    ...extra,
  }
}

// A daily series from Sep 1 to yesterday, the same credits each day.
function daily(perDay, from = Date.parse('2026-09-01T12:00:00Z'), to = now - DAY) {
  const out = []
  for (let t = from; t <= to; t += DAY)
    out.push({
      date: new Date(t).toISOString().slice(0, 10),
      credits: { ...perDay },
      usage: { db_compute: (perDay.db_compute || 0) / 10 },
    })
  return out
}

function snap(sites, perDay = null, available = { plan: 5000, packs: 0 }) {
  const s = {
    at: new Date(now).toISOString(),
    team: { slug: 't', name: 'Team', planName: 'Pro' },
    period: { start: new Date(start).toISOString(), end: new Date(start + 30 * DAY).toISOString() },
    plan,
    billing: null,
    sites,
  }
  if (perDay) {
    const meters = Object.fromEntries(Object.entries(perDay).map(([k, v]) => [k, v * 15]))
    s.billing = {
      plan: { used: 0, available: available.plan, total: 5000 },
      packs: { used: 0, available: available.packs, total: available.packs },
      blocks: [],
      meters,
      daily: daily(perDay),
    }
  }
  return s
}

test('project uses this period once a week has passed', () => {
  const p = period(snap([]), now)
  assert.equal(project(30, 999, p), 60)
})

test('project leans on last period early on', () => {
  const p = period(snap([]), start + 2 * DAY)
  // (4 + 60) deploys over 32 days, 28 days to go.
  assert.equal(project(4, 60, p), 4 + (64 / 32) * 28)
})

test('monthlyBill counts packs and prices each credit past the plan', () => {
  assert.equal(monthlyBill(5000, plan).packs, 0)
  assert.equal(monthlyBill(5001, plan).packs, 1)
  assert.equal(monthlyBill(8001, plan).packs, 3)
  assert.equal(Math.round(monthlyBill(8001, plan).total), 40)
})

test('meters take their pace from the last seven days', () => {
  const a = analyze(snap([site('a', 0, 0)], { db_compute: 200, web_requests: 2 }), { pricing, now })
  assert.equal(a.meters[0].id, 'db_compute')
  assert.equal(a.meters[0].perDay, 200)
  assert.equal(Math.round(a.perDay), 202)
})

test('the balance sets the run-out day and the packs still to buy', () => {
  // 2,000 credits left at 400 a day: gone in 5 days, 15 days to go.
  const a = analyze(snap([site('a', 0, 0)], { db_compute: 400 }, { plan: 1500, packs: 500 }), { pricing, now })
  assert.equal(new Date(a.runOut).toISOString().slice(0, 10), '2026-10-21')
  assert.equal(a.thisPeriod.morePacks, 3)
  assert.equal(a.painSpots[0].title.startsWith('Credits run out'), true)
  assert.equal(a.painSpots[0].severity, 'high')
})

test('an always-on database is a pain spot with a brief', () => {
  const db = { minCU: 0.25, maxCU: 4, sleepSeconds: 300 }
  // 240 credits = 24 GB-hours a day: one 1 GB database awake all day.
  const a = analyze(snap([site('app', 0, 0, { database: db })], { db_compute: 240 }), { pricing, now })
  const spot = a.painSpots.find((s) => s.title.startsWith('Database compute'))
  assert.equal(spot.severity, 'high')
  assert.match(spot.detail, /as much as one database at minimum size/)
  assert.match(spot.brief, /app \(sleeps after 300s idle\)/)
})

test('a site that pushes the plan into packs two periods running is a move', () => {
  // Big ships 30 deploys a day, 450 credits; small ships under one.
  const s = snap([site('big', 450, 900), site('small', 10, 20)], { production_deploys: 460 })
  const a = analyze(s, { pricing, now })
  assert.equal(a.sites.find((x) => x.name === 'big').verdict, 'MOVE')
  assert.equal(a.sites.find((x) => x.name === 'small').verdict, 'STAY')
  assert.deepEqual(a.moveAll.names, ['big'])
  assert.ok(a.painSpots.some((p) => p.title === 'Move big to Azure SWA Free'))
})

test('saving only at this pace is a watch, not a move', () => {
  // Last period's series is quiet, so moving would not have saved anything then.
  const s = snap([site('big', 180, 10)], { production_deploys: 180 })
  s.billing.daily = [...daily({ production_deploys: 5 }, Date.parse('2026-09-01T12:00:00Z'), start - DAY), ...daily({ production_deploys: 180 }, start + DAY / 2)]
  const a = analyze(s, { pricing, now })
  assert.equal(a.sites[0].verdict, 'WATCH')
})

test('config blockers and pins override the numbers', () => {
  const s = snap([site('a', 180, 360), site('b', 1, 1)], { production_deploys: 181 })
  const config = { sites: { a: { pin: 'client wants Netlify' }, b: { blocker: 'needs a worker that runs for hours' } } }
  const a = analyze(s, { pricing, config, now })
  assert.equal(a.sites.find((x) => x.name === 'a').verdict, 'STAY')
  assert.equal(a.sites.find((x) => x.name === 'b').verdict, 'MOVE')
})

test('without the billing endpoints it falls back to deploy credits', () => {
  const a = analyze(snap([site('a', 100, 0)]), { pricing, now })
  assert.equal(a.estimated, true)
  assert.equal(a.used, 1500)
})
