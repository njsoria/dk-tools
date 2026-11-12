// What a prompt earns (a rule or the classifier's verdict), and what a turn
// then runs on once the guards have had their say. All of it is pure: the
// classifier is called from register.tsx.

import { type Verdict, clean } from './classify'
import { type Effort, type Rates, type Role, type Routes, type Rule, effortRank, model, nextEffort, price, stronger, task as taskNamed, tier, weaker } from './config'

// What the prompt asked for, before any guard.
export type Route = { model: string; name: string; effort: Effort; via: string; task?: string }

// What a turn runs on, and why, when that isn't simply the route.
export type Settled = { model: string; effort: Effort; held?: boolean; note?: string }

// A least model (and effort) the router won't go beneath for a while, and why.
// `turns` counts the person's prompts it has left; undefined holds until lifted.
export type Floor = { model: string; effort?: Effort; why: string; turns?: number }

// How this session's turns have gone: requests, output tokens, and the time
// from one prompt to the next. Undefined until a turn has finished.
export type Habits = { steps?: number; output?: number; spanMs?: number }

// The situation a turn starts in.
export type Now = {
  // The model the conversation's last request went to.
  before: string
  // Tokens the last request carried: what a switch must write again.
  context: number
  messages: number
  // The floors that raise the route: an escalation's, and a role's.
  floors: Floor[]
  // A role's ceiling, which the route is kept under once the floors have raised it.
  ceiling?: { model: string; why: string }
  // The person's own floor, the last word: only it goes above a ceiling.
  chosen?: Floor
  habits: Habits
}

export const routeTask = (routes: Routes, name: string, effort: Effort | undefined, via: string): Route => {
  const task = taskNamed(routes, name)
  const target = model(routes, task.model)
  return { model: target.id, name: target.name, effort: effort === undefined ? task.effort : stronger(task.effort, effort), via, task: task.name }
}

const ruled = (routes: Routes, rule: Rule): Route => {
  if ('task' in rule) return routeTask(routes, rule.task, undefined, rule.why)
  const target = model(routes, rule.model)
  return { model: target.id, name: target.name, effort: rule.effort, via: rule.why }
}

// The stronger model and the harder effort of two routes.
const atLeast = (routes: Routes, route: Route, least: Route): Route => {
  const isWeaker = tier(routes, route.model) < tier(routes, least.model)
  const effort = stronger(route.effort, least.effort)
  if (!isWeaker && effort === route.effort) return route
  return { ...(isWeaker ? least : route), effort, via: `${route.via}; raised, ${least.via}` }
}

// The rules a text matches: one that decides the route outright, or the
// `atLeast` ones that only raise what the classifier answers.
export function byRules(routes: Routes, text: string) {
  const said = clean(text)
  const matches = routes.rules.filter(rule => new RegExp(rule.match, 'i').test(said))
  const decider = matches.find(rule => rule.atLeast !== true)
  return { decided: decider === undefined ? undefined : ruled(routes, decider), raises: matches }
}

// The route in force carried on to a thin prompt, still raised by any
// `atLeast` rule the text matched.
export const keepRoute = (routes: Routes, previous: Route, raises: Rule[], why: string): Route =>
  raises.reduce((best, rule) => atLeast(routes, best, ruled(routes, rule)), { ...previous, via: `${why} (${previous.via})` })

// Too few words, and no question, to say what job it is.
export const isThin = (routes: Routes, text: string) => {
  const said = clean(text)
  const max = routes.guards?.shortWords ?? 2
  return said !== '' && !said.includes('?') && said.split(/\s+/).length <= max
}

// The classifier's task, never run below its own model and effort, nor below
// any task Jev said yes to on its own, nor below any `atLeast` rule the text
// matched.
export const fromVerdict = (routes: Routes, verdict: Verdict, raises: Rule[]) =>
  raises.reduce(
    (best, rule) => atLeast(routes, best, ruled(routes, rule)),
    (verdict.raises ?? []).reduce(
      (best, task) => atLeast(routes, best, routeTask(routes, task.name, undefined, `jev says ${task.name}`)),
      routeTask(routes, verdict.task.name, verdict.effort, verdict.via),
    ),
  )

// The model one tier up, or the same at the top.
export const above = (routes: Routes, id: string) => routes.models[Math.min(tier(routes, id) + 1, routes.models.length - 1)]!

// A turn fell short on `ran`: the next ones start a tier above it, or, at the
// top tier already, think a level harder. A tier with `escalateFrom` is dear
// enough that the model beneath first thinks a level harder, until it reaches
// that effort: effort before model.
export function escalate(routes: Routes, ran: { model: string; effort: Effort }, why: string): Floor {
  const at = tier(routes, ran.model)
  const up = above(routes, ran.model)
  const isTop = tier(routes, up.id) === at
  const isHarderFirst = !isTop && at < routes.models.length && up.escalateFrom !== undefined && effortRank(ran.effort) < effortRank(up.escalateFrom)
  if (isHarderFirst) return { model: routes.models[at]!.name, effort: nextEffort(ran.effort), why, turns: routes.guards?.holdTurns ?? 3 }
  return {
    model: up.name,
    effort: isTop ? nextEffort(ran.effort) : ran.effort,
    why,
    turns: routes.guards?.holdTurns ?? 3,
  }
}

const priceAt =(routes: Routes, id: string, context: number): Rates | undefined => {
  const base = price(routes, id)
  const long = base?.longContext
  return long !== undefined && context > long.above ? long : base
}

const usd = (n: number) => `$${n.toFixed(2)}`

// Whether running this turn on `to` instead of `from` saves more than the
// switch costs. Caches are kept per model: the first request on `to` writes
// the whole conversation again, and the return to `from` does too if its
// cache has expired by then. A conversation the router can't price falls
// back to a plain length limit.
export function stepDownPays(routes: Routes, from: string, to: string, now: Now): { pays: boolean; why?: string } {
  const s = routes.switching ?? {}
  const a = priceAt(routes, from, now.context)
  const b = priceAt(routes, to, now.context)
  if (a === undefined || b === undefined) {
    const limit = s.fallbackMessages ?? 30
    return now.messages <= limit ? { pays: true } : { pays: false, why: `long conversation (${now.messages} messages)` }
  }
  const steps = now.habits.steps ?? s.expectedSteps ?? 6
  const output = (now.habits.output ?? s.expectedOutput ?? 2500) / 1e6
  const context = now.context / 1e6
  // The turn on each model with a warm cache: every request reads the conversation.
  const stay = steps * context * a.cacheRead + output * a.output
  const go = steps * context * b.cacheRead + output * b.output
  // The switch: `to` writes what it would have read, and `from` may have to
  // write it all again on the way back. The last request on `from` and the next
  // are about two prompts apart.
  const ttl = (s.cacheTtlMinutes ?? 5) * 60_000
  const isColdReturn = 2 * (now.habits.spanMs ?? 120_000) >= ttl
  const cost = context * (b.cacheWrite - b.cacheRead) + (isColdReturn ? context * (a.cacheWrite - a.cacheRead) : 0)
  const saved = stay - go
  const margin = s.margin ?? 1.5
  if (saved > 0 && saved >= margin * cost) return { pays: true }
  return { pays: false, why: `switching would cost ~${usd(cost)} to save ~${usd(Math.max(saved, 0))}` }
}

// An effort no harder than the model takes (its `maxEffort`).
export const capped = (routes: Routes, id: string, effort: Effort) => {
  const most = routes.models[tier(routes, id)]?.maxEffort
  return most === undefined ? effort : weaker(effort, most)
}

// Raises `target` and `effort` to a floor, and says so in `notes`.
const raise = (routes: Routes, floor: Floor, at: { target: string; effort: Effort }, notes: string[]) => {
  const isBelow = tier(routes, at.target) < tier(routes, floor.model)
  const isLighter = floor.effort !== undefined && stronger(at.effort, floor.effort) !== at.effort
  if (isBelow) at.target = model(routes, floor.model).id
  if (isLighter) at.effort = floor.effort!
  if (isBelow || isLighter) notes.push(floor.why)
}

// What a main-loop turn runs on: the route, raised to any floor, to a model
// trusted with this much context, kept under a role's ceiling unless the
// person's own floor says otherwise, and held on the model in use when a step
// down wouldn't pay for its switch. No model runs above its `maxEffort`.
export function settle(routes: Routes, wanted: Route, now: Now): Settled {
  const at = { target: wanted.model, effort: wanted.effort }
  const notes: string[] = []

  for (const floor of now.floors) raise(routes, floor, at, notes)

  // A long conversation needs a model trusted to keep all of it in mind.
  for (let level = tier(routes, at.target); level < routes.models.length - 1; level++) {
    const max = routes.models[level]!.maxContext
    if (max === undefined || now.context <= max) break
    at.target = routes.models[level + 1]!.id
    notes.push(`${Math.round(now.context / 1000)}K of context is past ${routes.models[level]!.name}'s ${Math.round(max / 1000)}K`)
  }

  const ceiling = now.ceiling
  const isOverCeiling = (id: string) => ceiling !== undefined && tier(routes, id) > tier(routes, ceiling.model)
  if (isOverCeiling(at.target)) {
    at.target = model(routes, ceiling!.model).id
    notes.push(ceiling!.why)
  }

  if (now.chosen !== undefined) raise(routes, now.chosen, at, notes)

  const { target, effort } = at
  const isRaised = target !== wanted.model
  const isSameTier = tier(routes, target) === tier(routes, now.before)
  // Same tier: keep the variant in use (`[1m]`, say).
  if (isSameTier) return { model: now.before, effort: capped(routes, now.before, effort), held: false, note: notes.join('; ') || undefined }

  // A model above the ceiling is never held on, whatever the switch costs.
  if (tier(routes, target) < tier(routes, now.before) && !isOverCeiling(now.before)) {
    const check = stepDownPays(routes, now.before, target, now)
    if (!check.pays) return { model: now.before, effort: capped(routes, now.before, effort), held: true, note: [...notes, `model kept: ${check.why}`].join('; ') }
  }
  return { model: target, effort: capped(routes, target, effort), held: false, note: isRaised ? notes.join('; ') : undefined }
}

// What a struggling turn moves up to: the escalation's floor, kept under a
// role's ceiling unless the turn already ran above it, at no more effort than
// the model takes.
export function struggle(routes: Routes, ran: { model: string; effort: Effort }, up: Floor, ceiling?: string) {
  let to = model(routes, up.model).id
  if (ceiling !== undefined && tier(routes, to) > tier(routes, ceiling)) to = tier(routes, ran.model) > tier(routes, ceiling) ? ran.model : model(routes, ceiling).id
  return { model: to, effort: capped(routes, to, up.effort ?? ran.effort) }
}

// The role a prompt sets: the first, in the order listed, whose `origins` hold
// the prompt's origin kind, or whose `match` a person's prompt matches.
export function roleFor(routes: Routes, prompt: { text: string; origin: string; isPerson: boolean }) {
  const said = clean(prompt.text)
  const found = Object.entries(routes.roles ?? {}).find(
    ([, role]) => role.origins?.includes(prompt.origin) === true || (prompt.isPerson && role.match !== undefined && new RegExp(role.match, 'i').test(said)),
  )
  return found?.[0]
}

// The role a skill sets, when routes.json lists the skill under one.
export const roleForSkill = (routes: Routes, skill: string) => Object.entries(routes.roles ?? {}).find(([, role]) => role.skills?.includes(skill) === true)?.[0]

// Every origin kind some role is set by: prompts of these kinds are routed as a person's are.
export const roleOrigins = (routes: Routes) => new Set(Object.values(routes.roles ?? {}).flatMap(role => role.origins ?? []))

// A role as the floor it holds, until lifted.
export const roleFloor = (name: string, role: Role): Floor => ({ model: role.model, effort: role.effort, why: name })

// What the router tells a session whose skill set its role: what the session
// itself runs on, what to start write sessions with so their own router keeps
// them there, and how subagents are picked.
export function modelsNote(routes: Routes, name: string) {
  const role = routes.roles?.[name]
  if (role === undefined) return undefined
  const worker = Object.entries(routes.roles ?? {}).find(([other, one]) => other !== name && (one.origins?.length ?? 0) > 0)
  const ceiling = routes.subagents?.ceiling
  const lines = [
    '## Models in force (Kore Model Router)',
    '',
    `- This session: ${model(routes, role.model).id} · ${role.effort}, held until \`/router role off\`.`,
  ]
  if (worker !== undefined) {
    const [workerName, one] = worker
    lines.push(
      `- Write sessions: start them with \`model: "${model(routes, one.model).id}"\` and \`effort: "${one.effort}"\`, and open each brief with the line \`Router: ${workerName}\`, so the worker's own router keeps it there.`,
    )
  }
  lines.push(
    ceiling === undefined
      ? '- Subagents: leave `model` unset; the router picks one per task. Name a model only to go higher.'
      : `- Subagents: leave \`model\` unset; the router picks one per task and never above ${ceiling}. Name a model only to go higher.`,
  )
  return lines.join('\n')
}
