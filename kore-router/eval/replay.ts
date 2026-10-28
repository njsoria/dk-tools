// Replays prompts the router really saw, from this machine's decision logs,
// through one or two routes.json files, and counts where they land. The labelled
// suite (run.ts) says whether routes are right; this says what a change does to
// the traffic you actually send, such as how much of it runs on Opus.
//
//   npx -y tsx@4.19.2 eval/replay.ts [--sample 300] [--logs logs] [--routes routes.json] [--against old-routes.json]
//
// The logs keep each prompt but not the conversation before it, so every prompt
// is classified on its own, and a short reply that would have kept the route in
// force is counted, not classified. It needs TYPESAFE_API_KEY, as run.ts does,
// and makes one Jev call per prompt per routes file. Results go to
// eval/results/, which git ignores: they hold your prompts.

import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { JEV_URL, clean, jevBody, readJev, state } from '../hooks/classify'
import { type Routes, check, tier } from '../hooks/config'
import { byRules, fromVerdict, isThin } from '../hooks/decide'

const arg = (name: string, fallback?: string) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]!
}

const here = __dirname
const routesPath = resolve(arg('routes', join(here, '..', 'routes.json'))!)
const againstPath = arg('against')
const logsDir = resolve(arg('logs', join(here, '..', 'logs'))!)
const sample = Number(arg('sample', '300'))

const load = (path: string) => check(JSON.parse(readFileSync(path, 'utf8')) as Routes)

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

// Every prompt the person typed (not a subagent's), each once, in a fixed
// shuffle so two runs replay the same sample.
function prompts() {
  const seen = new Set<string>()
  for (const file of readdirSync(logsDir).filter(name => name.endsWith('.routes.jsonl'))) {
    for (const line of readFileSync(join(logsDir, file), 'utf8').split('\n')) {
      if (line.trim() === '') continue
      const row = JSON.parse(line) as { prompt?: string; agent?: unknown }
      if (row.agent === undefined && typeof row.prompt === 'string' && clean(row.prompt) !== '') seen.add(row.prompt)
    }
  }
  let seed = 7
  const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647
  return [...seen]
    .map(prompt => ({ prompt, at: next() }))
    .sort((a, b) => a.at - b.at)
    .slice(0, sample)
    .map(each => each.prompt)
}

type Landed = { model: string; task: string; via: string } | { kept: string } | { error: string }

async function land(routes: Routes, prompt: string): Promise<Landed> {
  const { decided, raises } = byRules(routes, prompt)
  if (decided !== undefined) return { model: decided.name, task: decided.task ?? 'rule', via: decided.via }
  const said = clean(prompt)
  const events = routes.guards?.events
  if (events !== undefined && new RegExp(events, 'i').test(said)) return { kept: 'from the harness' }
  const followUp = routes.guards?.followUp
  if (followUp !== undefined && new RegExp(followUp, 'i').test(said)) return { kept: 'a follow-up' }
  if (isThin(routes, prompt)) return { kept: 'too short' }
  try {
    const reply = await fetch(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: jevBody(routes, state(prompt, [])),
      signal: AbortSignal.timeout(routes.timeoutMs * 2),
    })
    if (!reply.ok) throw new Error(`Jev answered ${reply.status}`)
    const route = fromVerdict(routes, readJev(routes, await reply.text()), raises)
    return { model: routes.models[tier(routes, route.model)]?.name ?? route.model, task: route.task ?? 'rule', via: route.via }
  } catch (error) {
    return { error: (error as Error).message }
  }
}

async function replay(routes: Routes, all: string[]) {
  const out: Landed[] = []
  for (let at = 0; at < all.length; at += 4) out.push(...(await Promise.all(all.slice(at, at + 4).map(prompt => land(routes, prompt)))))
  return out
}

const name = (landed: Landed) => ('kept' in landed ? `kept: ${landed.kept}` : 'error' in landed ? 'failed' : landed.model)

function tally(label: string, landed: Landed[]) {
  const count = (pick: (each: Landed) => string | undefined) => {
    const counts = new Map<string, number>()
    for (const each of landed) {
      const key = pick(each)
      if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...counts].sort((a, b) => b[1] - a[1]).map(([key, n]) => `  ${key.padEnd(24)} ${String(n).padStart(4)}  ${Math.round((n / landed.length) * 100)}%`)
  }
  return [`${label}`, 'Model:', ...count(name), 'Task:', ...count(each => ('task' in each ? each.task : undefined))].join('\n')
}

async function main() {
  const all = prompts()
  const routes = load(routesPath)
  const now = await replay(routes, all)
  const report = [`${all.length} logged prompts from ${logsDir}, each without the conversation before it`, '', tally(routesPath, now)]
  let before: Landed[] | undefined
  if (againstPath !== undefined) {
    before = await replay(load(resolve(againstPath)), all)
    report.push('', tally(resolve(againstPath), before), '', 'Moved (before → now):')
    const moves = new Map<string, number>()
    before.forEach((was, i) => {
      const move = `${name(was)} → ${name(now[i]!)}`
      if (name(was) !== name(now[i]!)) moves.set(move, (moves.get(move) ?? 0) + 1)
    })
    report.push(...[...moves].sort((a, b) => b[1] - a[1]).map(([move, n]) => `  ${move.padEnd(36)} ${n}`))
  }
  console.log(report.join('\n'))
  const dir = join(here, 'results')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `replay-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(file, JSON.stringify({ routes: routesPath, against: againstPath, rows: all.map((prompt, i) => ({ prompt, now: now[i], before: before?.[i] })) }, null, 2))
  console.log(`\nEvery prompt: ${file}`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
