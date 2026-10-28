// Measures how well the router sorts real prompts. Each labelled case in
// cases.json goes through the same code the plugin runs before a turn: the
// rules, then Jev, then the task floors and `atLeast` rules. Run several times
// to see how steady the answers are.
//
//   npx -y tsx@4.19.2 eval/run.ts [--runs 5] [--routes routes.json] [--cases eval/cases.json] [--order reverse]
//
// Jev can lean toward the first option it is offered. `--order reverse` offers
// the tasks in the opposite order: a route that moves with the order is one to
// tighten in routes.json.
//
// It needs TYPESAFE_API_KEY, from the environment or a .env beside routes.json,
// and makes one Jev call per case per run (well under a cent for the suite).

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { JEV_URL, jevBody, readJev, state } from '../hooks/classify'
import { type Routes, check, tier } from '../hooks/config'
import { type Route, byRules, fromVerdict } from '../hooks/decide'

type Case = { prompt: string; task: string; also?: string[]; hard?: boolean; earlier?: { from: string; text: string }[] }
type Answer = { route?: Route; error?: string; ms: number }

const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]!
}

const here = __dirname
const routesPath = resolve(arg('routes', join(here, '..', 'routes.json')))
const casesPath = resolve(arg('cases', join(here, 'cases.json')))
const runs = Number(arg('runs', '5'))
const order = arg('order', 'listed')

const routes = check(JSON.parse(readFileSync(routesPath, 'utf8')) as Routes)
if (order === 'reverse') routes.tasks.reverse()
const cases = (JSON.parse(readFileSync(casesPath, 'utf8')) as { cases: Case[] }).cases

const fromFile = () => {
  try {
    return /^TYPESAFE_API_KEY=(.+)$/m.exec(readFileSync(join(dirname(routesPath), '.env'), 'utf8'))?.[1]?.trim()
  } catch {
    return undefined
  }
}
const key = process.env.TYPESAFE_API_KEY ?? fromFile()
if (key === undefined) {
  console.error('TYPESAFE_API_KEY is not set, in the environment or in a .env beside routes.json.')
  process.exit(1)
}

// The route a case gets, as the plugin would give it before any turn guard.
async function routeOf(one: Case): Promise<Answer> {
  const started = performance.now()
  try {
    const { decided, raises } = byRules(routes, one.prompt)
    if (decided !== undefined) return { route: decided, ms: performance.now() - started }
    const rows = (one.earlier ?? []).map(row => ({ role: row.from, text: row.text }))
    const reply = await fetch(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: jevBody(routes, state(one.prompt, rows)),
      signal: AbortSignal.timeout(routes.timeoutMs),
    })
    if (!reply.ok) throw new Error(`Jev answered ${reply.status}`)
    const route = fromVerdict(routes, readJev(routes, await reply.text()), raises)
    return { route, ms: performance.now() - started }
  } catch (error) {
    return { error: (error as Error).message, ms: performance.now() - started }
  }
}

// What the router should run a case on: its task's model, raised by any
// `atLeast` rule the prompt matches, the same as a right answer would be.
const expected = (one: Case, task: string) => {
  const { raises } = byRules(routes, one.prompt)
  const named = routes.tasks.find(each => each.name === task)!
  return fromVerdict(routes, { task: named, effort: named.effort, via: 'label' }, raises)
}

async function main() {
const results: { one: Case; answers: Answer[] }[] = cases.map(one => ({ one, answers: [] }))
for (let run = 0; run < runs; run++) {
  // A few at a time: quick, and gentle on the API.
  for (let at = 0; at < results.length; at += 4) {
    const batch = results.slice(at, at + 4)
    const answers = await Promise.all(batch.map(each => routeOf(each.one)))
    batch.forEach((each, i) => each.answers.push(answers[i]!))
  }
  process.stdout.write(`run ${run + 1}/${runs} done\n`)
}

const pct = (n: number, of: number) => `${of === 0 ? 0 : Math.round((n / of) * 100)}%`
let total = 0
let failed = 0
let taskExact = 0
let taskOk = 0
let modelOk = 0
let under = 0
let over = 0
let steady = 0
const times: number[] = []
const misses: string[] = []
const byTask = new Map<string, { n: number; ok: number }>()
const bySet = new Map<string, { n: number; ok: number; under: number }>()

for (const { one, answers } of results) {
  const accepted = [one.task, ...(one.also ?? [])]
  const fits = accepted.map(task => expected(one, task))
  const lowest = Math.min(...fits.map(route => tier(routes, route.model)))
  const highest = Math.max(...fits.map(route => tier(routes, route.model)))
  const seen = new Set<string>()
  for (const answer of answers) {
    total += 1
    times.push(answer.ms)
    if (answer.route === undefined) {
      failed += 1
      seen.add(`error: ${answer.error}`)
      continue
    }
    const route = answer.route
    const at = tier(routes, route.model)
    const isTaskOk = route.task !== undefined && accepted.includes(route.task)
    const isModelOk = at >= lowest && at <= highest
    taskExact += route.task === one.task ? 1 : 0
    taskOk += isTaskOk ? 1 : 0
    modelOk += isModelOk ? 1 : 0
    under += at < lowest ? 1 : 0
    over += at > highest ? 1 : 0
    const row = byTask.get(one.task) ?? { n: 0, ok: 0 }
    byTask.set(one.task, { n: row.n + 1, ok: row.ok + (isModelOk ? 1 : 0) })
    const set = one.hard ? 'hard' : 'plain'
    const sum = bySet.get(set) ?? { n: 0, ok: 0, under: 0 }
    bySet.set(set, { n: sum.n + 1, ok: sum.ok + (isModelOk ? 1 : 0), under: sum.under + (at < lowest ? 1 : 0) })
    seen.add(`${route.task ?? 'rule'} → ${route.name} · ${route.effort}`)
    if (!isModelOk) misses.push(`${at < lowest ? 'UNDER' : 'OVER '}  "${one.prompt}"  wanted ${accepted.join('/')}, got ${route.task ?? 'a rule'} → ${route.name} · ${route.effort} (${route.via})`)
  }
  if (seen.size === 1) steady += 1
  else misses.push(`SHIFT  "${one.prompt}"  answered ${[...seen].join(' | ')}`)
}

times.sort((a, b) => a - b)
const p = (q: number) => Math.round(times[Math.min(times.length - 1, Math.floor(q * times.length))] ?? 0)
const answered = total - failed
const report = [
  `${cases.length} cases × ${runs} runs = ${total} routings (${failed} failed), classifier ${routes.classifier} ${routes.jevModel ?? ''}, tasks in ${order} order`,
  '',
  `Right model:     ${pct(modelOk, answered)}   (the model the labelled task runs on, or an accepted alternative's)`,
  `Under-routed:    ${pct(under, answered)}   (a weaker model than the job needs: the quality risk)`,
  `Over-routed:     ${pct(over, answered)}   (a stronger model than the job needs: the cost)`,
  `Right task:      ${pct(taskOk, answered)}   (${pct(taskExact, answered)} the labelled one exactly)`,
  `Steady:          ${pct(steady, cases.length)}   (cases that got the same route on every run)`,
  `Latency:         p50 ${p(0.5)} ms · p95 ${p(0.95)} ms · max ${p(1)} ms`,
  '',
  'Right model by set:',
  ...[...bySet].map(([set, row]) => `  ${set.padEnd(11)} ${pct(row.ok, row.n).padStart(4)}  (${row.n}, ${pct(row.under, row.n)} under-routed)`),
  '',
  'Right model by labelled task:',
  ...[...byTask].map(([task, row]) => `  ${task.padEnd(11)} ${pct(row.ok, row.n).padStart(4)}  (${row.n})`),
  ...(misses.length === 0 ? [] : ['', 'Misses and shifts:', ...[...new Set(misses)].map(line => `  ${line}`)]),
].join('\n')
console.log(`\n${report}`)

const out = join(here, 'results')
mkdirSync(out, { recursive: true })
const file = join(out, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
writeFileSync(file, JSON.stringify({ routes: routesPath, runs, report, results }, null, 2))
console.log(`\nEvery answer: ${file}`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
