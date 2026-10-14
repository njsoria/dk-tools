// Kore Model Router: sends each prompt, and each subagent, to the model and effort
// its job deserves.
//
// Rules in routes.json are tried first; what they don't settle goes to a cheap
// classifier, Jev (TypeSafe) or Haiku, which names the kind of job (a task).
// Each task has the least model and effort it is ever run on. Guards then
// raise a turn, never lower it: a floor after the person pushes back or a
// turn struggles, a model trusted with the conversation's length, and a step
// down only when it saves more than the switch costs. `/router off` hands the
// session back to its own model; `/router pane` opens a live view of the
// decisions; `/router savings` prices what they saved.

// Everything that touches the engine lives in this file: the plugin host
// follows `$` only into functions declared here. The decisions themselves are
// pure, in decide.ts and the modules beside it.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import { JEV_URL, type Verdict, clean, clip, haikuSystem, jevBody, readHaiku, readJev, state } from './classify'
import { type Effort, type Routes, check, model, tier } from './config'
import { type Floor, type Habits, type Route, type Settled, byRules, escalate, fromVerdict, isThin, keepRoute, routeTask, settle } from './decide'
import { type Entry, type Spend, savings } from './ledger'
import { LIME, details, firstLine, summary } from './pane'

const PANE = 'router'
// How many of this session's decisions the pane lists, newest first.
const SHOWN = 30
// How much of the conversation the classifier reads before a request.
const TAIL = 4
// A prompt is routed when a person sent it, not when a notification did.
const FROM_A_PERSON = new Set(['composer', 'bridge', 'sdk'])
const LATE = Symbol('late')
// The router's line under the prompt, held by the host: a write redraws the
// hint that reads it, which a module variable and an invalidate did not always.
const hint = atom({ plugin: 'kore-model-router', key: 'line' } as const, null)

async function show($: EngineInterface, text: string | undefined) {
  await update($, hint, () => text ?? null)
}

// A click on the router's line opens the pane, or closes it when it is up.
async function togglePane($: EngineInterface) {
  const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
  if (isUp) await $.ui.close({ id: PANE })
  else await $.ui.open({ id: PANE, title: 'Kore Model Router', focus: true })
}

const load = async ($: EngineInterface) => check(JSON.parse(await $.fs.read(`${$.plugin.root}/routes.json`)) as Routes)

// Sessions the desktop app starts don't always see the shell's environment,
// so the key can also sit in a .env file beside routes.json.
async function typesafeKey($: EngineInterface) {
  const fromEnv = await $.env.get('TYPESAFE_API_KEY')
  if (fromEnv !== undefined) return fromEnv
  const file = await $.fs.read(`${$.plugin.root}/.env`).catch(() => '')
  return /^TYPESAFE_API_KEY=(.+)$/m.exec(file)?.[1]?.trim()
}

// $.http.fetch has no time limit of its own.
async function within<T>($: EngineInterface, ms: number, work: Promise<T>) {
  const stop = new AbortController()
  const late = $.clock.sleep(ms, { signal: stop.signal }).then(
    () => LATE,
    () => LATE,
  )
  try {
    const first = await Promise.race([work, late])
    if (first === LATE) throw new Error(`no answer within ${ms} ms`)
    return first as T
  } finally {
    stop.abort()
  }
}

// What came before a request, as the classifier reads it.
type Rows = readonly { role: string; text: string }[]

async function askJev($: EngineInterface, routes: Routes, text: string, rows: Rows): Promise<Verdict> {
  const key = await typesafeKey($)
  if (key === undefined) throw new Error('TYPESAFE_API_KEY is not set')
  const reply = await within(
    $,
    routes.timeoutMs,
    $.http.fetch(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: jevBody(routes, state(text, rows)),
    }),
  )
  if (!reply.ok) throw new Error(`Jev answered ${reply.status}`)
  return readJev(routes, reply.text)
}

// Runs on the session's own login, so it needs no key; slower than Jev.
async function askHaiku($: EngineInterface, routes: Routes, text: string, rows: Rows): Promise<Verdict> {
  const reply = await $.model.complete({
    model: 'haiku',
    effort: 'low',
    timeoutMs: routes.timeoutMs,
    system: haikuSystem(routes),
    prompt: JSON.stringify(state(text, rows)),
  })
  if (!reply.isAnswered) throw new Error(`Haiku gave no answer (${reply.reason})`)
  return readHaiku(routes, reply.text)
}

// A rule settles it with no classifier call, and so does a short follow-up
// ("yes, go ahead") to the route in force; otherwise the classifier names a
// task, raised by any `atLeast` rule the text matched. The request alone
// misleads on a reply, so the classifier also reads `rows`, what came just
// before it; a subagent's task stands alone, with none.
async function decide($: EngineInterface, routes: Routes, text: string, rows: Rows, previous?: Route): Promise<Route & { ms?: number }> {
  const { decided, raises } = byRules(routes, text)
  if (decided !== undefined) return decided
  const followUp = routes.guards?.followUp
  if (previous !== undefined && followUp !== undefined && new RegExp(followUp, 'i').test(clean(text))) {
    return keepRoute(routes, previous, raises, 'a follow-up, so the route in force')
  }
  if (previous !== undefined && rows.length > 0 && isThin(routes, text)) {
    return keepRoute(routes, previous, raises, 'too short to classify, so the route in force')
  }
  const started = await $.clock.now()
  const verdict = routes.classifier === 'haiku' ? await askHaiku($, routes, text, rows) : await askJev($, routes, text, rows)
  return { ...fromVerdict(routes, verdict, raises), ms: Math.round((await $.clock.now()) - started) }
}

// Each session keeps its own two files under logs/, never trimmed: its
// decisions, which the pane reads, and its spend, one line per routed turn with
// token counts. $.fs has no append, so a file is read and rewritten; a file per
// session means no session rewrites another's lines.
const LOGS = 'logs'
const DECISIONS = 'routes.jsonl'
const SPEND = 'spend.jsonl'
// The one spend file every session shared before each had its own.
const OLD_SPEND = 'routes.spend.jsonl'

const logFile = async ($: EngineInterface, kind: string) => `${$.plugin.root}/${LOGS}/${await $.session.id()}.${kind}`

// One write at a time, so two of this session's lines can't rewrite each other.
let writing: Promise<unknown> = Promise.resolve()

function append($: EngineInterface, kind: string, entry: Record<string, unknown>) {
  writing = writing
    .then(async () => {
      const file = await logFile($, kind)
      const kept = await $.fs.read(file).catch(() => '')
      const line = JSON.stringify({
        at: new Date(await $.clock.now()).toISOString(),
        sessionId: await $.session.id(),
        ...entry,
      })
      await $.fs.write(file, `${kept}${line}\n`)
    })
    .catch(() => undefined)
  return writing
}

async function record($: EngineInterface, entry: Omit<Entry, 'at' | 'sessionId'> & Record<string, unknown>) {
  await append($, DECISIONS, entry)
  $.ui.invalidate('ui.render')
}

const recordSpend = ($: EngineInterface, spend: Omit<Spend, 'at' | 'sessionId'>) => append($, SPEND, spend)

// The newest decisions of this session, newest first. A new chat has its own
// file, so it starts with an empty pane rather than another's routes.
async function recent($: EngineInterface, count: number) {
  const text = await $.fs.read(await logFile($, DECISIONS)).catch(() => '')
  return text
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Entry)
    .slice(-count)
    .reverse()
}

// Every routed turn of every session, oldest first.
async function spent($: EngineInterface) {
  const dir = `${$.plugin.root}/${LOGS}`
  const names = (await $.fs.list(dir).catch(() => [])).map(entry => entry.name).filter(name => name.endsWith(`.${SPEND}`))
  const files = [`${$.plugin.root}/${OLD_SPEND}`, ...names.map(name => `${dir}/${name}`)]
  const texts = await Promise.all(files.map(file => $.fs.read(file).catch(() => '')))
  return texts
    .flatMap(text => text.split('\n').filter(Boolean).map(line => JSON.parse(line) as Spend))
    .sort((a, b) => a.at.localeCompare(b.at))
}

const say = (route: Route) => `${route.name} · ${route.effort} (${route.via})`
// The middle of a session's figures: one overnight pause mustn't make every
// prompt look an hour apart.
const median = (list: number[]) => (list.length === 0 ? undefined : [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)])

export const register: Register = on => {
  let isOn = true
  let routes: Routes | undefined
  // The route the newest prompt earned, and what each running turn began on:
  // a prompt typed mid-turn must not switch models under that turn.
  let latest: Route | undefined
  let lastModel: string | undefined
  // Tokens the main loop's last request carried: what a model switch rewrites.
  let lastContext = 0
  // What the last main turn ran on, which a pushback escalates from.
  let lastRan: Settled | undefined
  // A floor the person set with /router floor, and one an escalation set, which counts down.
  let chosen: Floor | undefined
  let floor: Floor | undefined
  let asked = ''
  // The router's line under the prompt, which opens its pane when clicked; the
  // copy kept here only spares a write when it hasn't changed.
  let line: string | undefined
  // The conversation's last few lines, kept as they pass so routing never has
  // to read the whole transcript; read once only for a resumed session.
  const tail: { role: string; text: string }[] = []
  let isTailRead = false
  // The pane's rows the person has opened, by their time.
  const expanded = new Set<string>()
  // How long the newest prompt's routing took, for its decision line.
  let timing: { classifyMs?: number; routeMs?: number } = {}
  const pinned = new Map<string, Settled | undefined>()
  // What a routed turn was set to and what it ran on, until its token counts arrive.
  const open = new Map<string, Omit<Spend, 'at' | 'sessionId' | 'tokens'>>()
  // Tool errors in the main turn under way, and the turns already moved up for them.
  let errors = 0
  const struggled = new Set<string>()
  // The subagents the router started, by id: the effort their steps take and their spend's labels.
  const agents = new Map<string, { effort: Effort } & Omit<Spend, 'at' | 'sessionId' | 'tokens'>>()
  // This session's own figures, which the step-down sum prefers to routes.json's guesses.
  const seen = { steps: [] as number[], output: [] as number[], spans: [] as number[], lastPromptAt: undefined as number | undefined }
  const steps = new Map<string, number>()
  const habits = (): Habits => ({ steps: median(seen.steps), output: median(seen.output), spanMs: median(seen.spans) })
  const remember = (role: string, text: string) => {
    if (clean(text) === '') return
    tail.push({ role, text: clip(text, 2000) })
    tail.splice(0, Math.max(0, tail.length - TAIL))
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'router',
      description: 'Model router: turn it on or off, set a floor, or try a prompt against it',
      argumentHint: '[on | off | pane (or open) | floor <model> | floor off | savings [model | session] | a prompt to try]',
    })

    // The router changes what a session runs on, so it says it is there.
    $.ui.toast('Kore Model Router is on. /router off to turn it off.')
    line = 'router: on'
    await show($, line)

    // A slow tick keeps the pane current should a redraw be missed.
    $.clock.every(3000, () => $.ui.invalidate('ui.render'))

    // The pane opens with the session unless routes.json says `"openPane": false`.
    // A pane that won't open must not stop the router from starting.
    try {
      if ((await load($)).openPane !== false) await $.ui.open({ id: PANE, title: 'Kore Model Router' })
    } catch {
      // `/router pane` still opens it by hand.
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const rows = await recent($, SHOWN)
    if (rows.length === 0) return <Text dimColor>No prompt has been routed yet.</Text>
    // A press opens or closes a row; the redraw shows it.
    const toggle = (key: string) => () => {
      if (!expanded.delete(key)) expanded.add(key)
      $.ui.invalidate('ui.render')
    }
    const all = (isOpen: boolean) => () => {
      for (const row of rows) {
        if (isOpen) expanded.add(row.at)
        else expanded.delete(row.at)
      }
      $.ui.invalidate('ui.render')
    }

    return (
      <Box flexDirection="column" paddingX={1} rowGap={1}>
        <Box columnGap={2}>
          <Button key="open-all" plain dimColor label="Open all" onPress={all(true)} />
          <Button key="close-all" plain dimColor label="Close all" onPress={all(false)} />
        </Box>
        {rows.map((row, at) => {
          const isOpen = expanded.has(row.at)
          return (
            <Box key={`row-${row.at}`} flexDirection="column">
              <Button key={`toggle-${row.at}`} plain label={`${isOpen ? '▾' : '▸'} ${summary(row)}`} onPress={toggle(row.at)} />
              {at === 0 && !isOpen && (
                <Text color={LIME} wrap="truncate-end">
                  {row.failed ?? row.note ?? `Decided by ${row.via}.`}
                </Text>
              )}
              {!isOpen && (
                <Text dimColor wrap="truncate-end">
                  {firstLine(row.prompt)}
                </Text>
              )}
              {isOpen &&
                details(row).map(([label, value]) => (
                  <Box key={`${row.at}-${label}`} columnGap={1}>
                    <Text dimColor>{`${label}:`}</Text>
                    <Text>{value}</Text>
                  </Box>
                ))}
            </Box>
          )
        })}
      </Box>
    )
  })

  // The terminal's line under the prompt leads with the router's route, as a
  // button that opens the pane, and keeps the engine's own hints after it.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const line = await read($, hint)
    if (line === null) return next(e)
    const { Box, Button } = $.ui.resolve(e)

    return (
      <Box columnGap={2}>
        <Button key="router-line" plain dimColor label={line} onPress={() => togglePane($)} />
        {await next(e)}
      </Box>
    )
  })

  // The desktop app never asks for the hint line. Under its input bar it draws
  // the session's mode labels, so there the route is the same button beside
  // them. The terminal's mode labels are left alone: its hint line has it.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.surface === 'terminal') return next(e)
    const line = await read($, hint)
    if (line === null) return next(e)
    const { Box, Button } = $.ui.resolve(e)

    return (
      <Box columnGap={1}>
        <Button key="router-line" plain dimColor label={line} onPress={() => togglePane($)} />
        {await next(e)}
      </Box>
    )
  })

  on('prompt.submit', async ($, e, next) => {
    if (isOn && FROM_A_PERSON.has(e.origin.kind)) {
      asked = clip(clean(e.text), 2000)
      const at = await $.clock.now()
      if (seen.lastPromptAt !== undefined) seen.spans.push(at - seen.lastPromptAt)
      seen.lastPromptAt = at
      // A floor counts down the person's prompts, then lifts.
      if (floor?.turns !== undefined) floor = floor.turns <= 1 ? undefined : { ...floor, turns: floor.turns - 1 }
      try {
        routes = await load($)
        const pushback = routes.guards?.pushback
        if (pushback !== undefined && lastRan !== undefined && new RegExp(pushback, 'i').test(clean(e.text))) {
          floor = escalate(routes, lastRan, 'escalated: you pushed back on the last turn')
        }
        if (!isTailRead && tail.length === 0) {
          tail.push(...(await $.session.messages()).map(row => ({ role: row.role, text: row.text })).filter(row => clean(row.text) !== '').slice(-TAIL))
        }
        isTailRead = true
        const decided = await decide($, routes, e.text, tail, latest)
        timing = { classifyMs: decided.ms, routeMs: Math.round((await $.clock.now()) - at) }
        latest = decided
      } catch (error) {
        // Routing must never be why a prompt fails: the last route stands, or
        // the session's own model when there has been none.
        line = `router: no new route (${(error as Error).message})`
        await show($, line)
        await record($, { prompt: asked, failed: (error as Error).message })
      }
      remember('user', e.text)
    }

    return next(e)
  })

  // A subagent starts on the model its task earns, unless it is a fork (which
  // must share its parent's model), a teammate or a workflow's agent. A model
  // the parent named is kept, or raised to the task's own if it is weaker.
  on('agent.spawn', async ($, e, next) => {
    // Newer engines say when a spawn is a teammate or a workflow's agent; older
    // ones (the CLI at 2.1.285) don't, and raise neither through this event.
    const kind = e as { workflow?: unknown; isTeammate?: boolean }
    if (!isOn || e.fork || kind.workflow !== undefined || kind.isTeammate === true) return next(e)
    const task = clip(clean(e.description || e.prompt), 120)
    let current: Routes
    let wanted: Route
    try {
      current = await load($)
      const typed = current.subagents?.types?.[e.subagentType]
      if (typed !== undefined) wanted = routeTask(current, typed, undefined, `${e.subagentType} agents`)
      else if (current.subagents?.classify !== false) wanted = await decide($, current, `${e.description}\n\n${e.prompt}`, [])
      else return next(e)
    } catch (error) {
      await record($, { prompt: task, failed: (error as Error).message, agent: e.subagentType })
      return next(e)
    }
    const named = e.model === undefined || e.model === 'inherit' ? undefined : e.model
    const isNamedKept = named !== undefined && tier(current, named) >= tier(current, wanted.model)
    const ran = isNamedKept ? (current.models.find(one => one.name === named)?.id ?? named) : wanted.model
    const result = await next({ ...e, model: ran })
    if (result.deny !== undefined) return result
    if (result.agentId !== undefined) {
      agents.set(result.agentId, { effort: wanted.effort, prompt: task, session: e.parentModel, ran, agent: e.subagentType })
    }
    await record($, {
      prompt: task,
      wanted: `${wanted.name} · ${wanted.effort}`,
      via: wanted.via,
      ran: `${ran} · ${wanted.effort}`,
      held: false,
      note: isNamedKept && ran !== wanted.model ? `kept the ${named} the call asked for` : undefined,
      agent: e.subagentType,
    })
    return result
  })

  // Tool errors in the main turn under way, which may mean it was routed too low.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && result.isError === true) errors += 1
    return result
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      // A routed subagent keeps the model it started on and takes its task's effort.
      const routed = agents.get(e.agentId)
      return yield* next(routed === undefined ? e : { ...e, effort: routed.effort })
    }

    if (!pinned.has(e.turnId)) {
      const isRouted = isOn && latest !== undefined && routes !== undefined
      const now = { before: lastModel ?? e.model, context: lastContext, messages: e.messageCount, floors: [chosen, floor].filter(one => one !== undefined), habits: habits() }
      const ran = isRouted ? settle(routes!, latest!, now) : undefined
      pinned.set(e.turnId, ran)
      errors = 0
      if (ran !== undefined) {
        lastRan = ran
        await record($, {
          prompt: asked,
          wanted: `${latest!.name} · ${latest!.effort}`,
          via: latest!.via,
          ran: `${ran.model} · ${ran.effort}`,
          held: ran.held === true,
          note: ran.note,
          session: e.model,
          sessionEffort: e.effort,
          messages: e.messageCount,
          ...timing,
        })
        open.set(e.turnId, {
          prompt: asked,
          session: e.model,
          sessionEffort: typeof e.effort === 'string' ? e.effort : undefined,
          ran: ran.model,
        })
      }
    } else {
      // A turn that keeps failing below the top model moves up a tier for the
      // rest of it, and the floor holds for the next few prompts too.
      const ran = pinned.get(e.turnId)
      const limit = routes?.guards?.toolErrors ?? 4
      if (ran !== undefined && routes !== undefined && !struggled.has(e.turnId) && errors >= limit) {
        struggled.add(e.turnId)
        const up = escalate(routes, ran, `escalated: ${errors} tool errors in one turn`)
        const raised = { model: model(routes, up.model).id, effort: up.effort ?? ran.effort, note: up.why }
        if (tier(routes, raised.model) > tier(routes, ran.model) || raised.effort !== ran.effort) {
          floor = up
          lastRan = raised
          pinned.set(e.turnId, raised)
          const spend = open.get(e.turnId)
          if (spend !== undefined) open.set(e.turnId, { ...spend, ran: raised.model })
          await record($, { prompt: asked, via: latest?.via, ran: `${raised.model} · ${raised.effort}`, note: raised.note, messages: e.messageCount })
        }
      }
    }
    const route = pinned.get(e.turnId)
    lastModel = route?.model ?? e.model
    steps.set(e.turnId, e.index + 1)
    const said = route === undefined ? line : `router: ${route.model.replace(/^claude-|-[\d-]+.*$/g, '')} · ${route.effort}${route.note === undefined ? '' : ` (${route.note})`}`
    if (said !== line) {
      line = said
      await show($, line)
    }

    const result = yield* next(route === undefined ? e : { ...e, model: route.model, effort: route.effort })
    if (result.usage !== null) {
      lastContext = result.usage.input_tokens + result.usage.cache_read_input_tokens + result.usage.cache_creation_input_tokens
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const routed = agents.get(e.agentId)
      if (routed !== undefined && e.usage !== undefined) {
        const { effort: _, ...labels } = routed
        await recordSpend($, { ...labels, tokens: tokensOf(e.usage) })
      }
      return next(e)
    }

    remember('assistant', e.answer)
    pinned.delete(e.turnId)
    struggled.delete(e.turnId)
    const count = steps.get(e.turnId)
    steps.delete(e.turnId)
    if (count !== undefined && !e.isAborted) seen.steps.push(count)
    if (e.usage !== undefined && !e.isAborted) seen.output.push(e.usage.output_tokens)
    const routed = open.get(e.turnId)
    open.delete(e.turnId)
    if (routed !== undefined && e.usage !== undefined) await recordSpend($, { ...routed, tokens: tokensOf(e.usage) })

    return next(e)
  })

  on('command.run', { command: 'router' }, async ($, e) => {
    const args = e.args.trim()
    if (args === 'on' || args === 'off') {
      isOn = args === 'on'
      line = isOn ? 'router: on' : undefined
      await show($, line)
      return { text: `Router is ${args}.` }
    }
    // `open` too: the word people reach for.
    if (args === 'pane' || args === 'open') {
      await $.ui.open({ id: PANE, title: 'Kore Model Router' })
      return { text: 'Router pane opened.' }
    }
    if (args === 'floor off') {
      chosen = undefined
      floor = undefined
      return { text: 'Floor lifted.' }
    }
    if (args.startsWith('floor ')) {
      try {
        const named = model(await load($), args.slice('floor '.length).trim())
        chosen = { model: named.name, why: `your floor: ${named.name}` }
        return { text: `This session won't run below ${named.name} until /router floor off.` }
      } catch (error) {
        return { text: (error as Error).message }
      }
    }
    if (args === 'savings' || args.startsWith('savings ')) {
      try {
        return { text: savings(await load($), await spent($), args.slice('savings'.length).trim() || undefined) }
      } catch (error) {
        return { text: `No figures: ${(error as Error).message}` }
      }
    }
    if (args === '') {
      const last = latest === undefined ? '' : ` Last route: ${say(latest)}.`
      const held = [chosen, floor]
        .filter(one => one !== undefined)
        .map(one => ` Floor: ${one.model}${one.effort === undefined ? '' : ` · ${one.effort}`} (${one.why}${one.turns === undefined ? '' : `, ${one.turns} more prompts`}).`)
        .join('')
      return { text: `Router is ${isOn ? 'on' : 'off'}.${last}${held}` }
    }
    try {
      return { text: say(await decide($, await load($), args, tail)) }
    } catch (error) {
      return { text: `No route: ${(error as Error).message}` }
    }
  })
}

const tokensOf = (usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }) => ({
  input: usage.input_tokens,
  output: usage.output_tokens,
  cacheRead: usage.cache_read_input_tokens,
  cacheWrite: usage.cache_creation_input_tokens,
})
