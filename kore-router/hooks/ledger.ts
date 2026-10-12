// What the router's logs hold, and what /router savings makes of them. The
// files themselves are read and written in register.tsx.

import { type Rates, type Routes, price } from './config'

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type Spend = {
  at: string
  sessionId: string
  prompt: string
  // The model the session (or, for a subagent, its parent) had selected.
  session: string
  sessionEffort?: string
  ran: string
  // The subagent's type, for a subagent's run.
  agent?: string
  tokens: Tokens
}

// One decision, as the pane shows it.
export type Entry = {
  at: string
  sessionId?: string
  prompt: string
  wanted?: string
  via?: string
  ran?: string
  held?: boolean
  // Why the turn didn't simply run as the prompt asked: a hold, a floor, an escalation.
  note?: string
  failed?: string
  messages?: number
  agent?: string
  session?: string
  sessionEffort?: string | number
  // How long the classifier took, and all of routing, in milliseconds.
  classifyMs?: number
  routeMs?: number
}

const cost = (rates: Rates, tokens: Tokens) =>
  (tokens.input * rates.input +
    tokens.output * rates.output +
    tokens.cacheRead * rates.cacheRead +
    tokens.cacheWrite * rates.cacheWrite) /
  1_000_000

const usd = (n: number) => `$${n.toFixed(2)}`
const family = (id: string) => id.replace(/^claude-|-[\d-]+.*$/g, '')

// The same tokens, priced as if the turn had run on `against`: a model name
// from routes.json, or `session` for whatever the session had selected.
export function savings(routes: Routes, turns: Spend[], against: string | undefined) {
  const wanted = against ?? routes.baseline?.model ?? 'opus'
  const isSession = wanted === 'session'
  const baseModel = routes.models.find(model => model.name === wanted || model.id === wanted)
  if (!isSession && baseModel === undefined) {
    return `No model called "${wanted}". Try ${routes.models.map(model => model.name).join(', ')} or session.`
  }

  let actual = 0
  let compared = 0
  let counted = 0
  const byModel = new Map<string, { turns: number; cost: number }>()
  const byLoop = { main: 0, subagents: 0 }
  for (const turn of turns) {
    const ranPrice = price(routes, turn.ran)
    const basePrice = price(routes, isSession ? turn.session : baseModel!.id)
    if (ranPrice === undefined || basePrice === undefined) continue
    const spentHere = cost(ranPrice, turn.tokens)
    actual += spentHere
    compared += cost(basePrice, turn.tokens)
    counted += 1
    const row = byModel.get(family(turn.ran)) ?? { turns: 0, cost: 0 }
    byModel.set(family(turn.ran), { turns: row.turns + 1, cost: row.cost + spentHere })
    byLoop[turn.agent === undefined ? 'main' : 'subagents'] += 1
  }
  if (counted === 0) return 'No routed turns with prices yet.'

  const label = isSession
    ? 'the model you had selected'
    : `${baseModel!.name}${routes.baseline?.model === wanted ? ` · ${routes.baseline.effort}` : ''}`
  const saved = compared - actual
  const skipped = turns.length - counted
  const split = [...byModel].map(([name, row]) => `${name} ${row.turns} (${usd(row.cost)})`).join(' · ')
  return [
    `Against ${label}, since ${turns[0]!.at.slice(0, 10)}, over ${counted} turns (${byLoop.main} yours, ${byLoop.subagents} subagents'):`,
    `  router ${usd(actual)}  vs  ${usd(compared)}  →  saved ${usd(saved)} (${((saved / compared) * 100).toFixed(0)}%)`,
    `  ran on: ${split}`,
    'Same tokens priced on both models; effort is not priced, only the model. A cheaper effort also thinks less, which this does not credit.',
    ...(skipped > 0 ? [`${skipped} turns skipped for want of a price in routes.json.`] : []),
  ].join('\n')
}
