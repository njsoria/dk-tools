// Kore Router: sends each prompt to the model and effort it deserves.
//
// Rules in routes.json are tried first; what they don't settle goes to a cheap
// classifier, Jev (TypeSafe) or Haiku. The route then rides on every model
// request of the turn. `/router off` hands the session back to its own model;
// `/router pane` opens a live view of the decisions.

import type { EngineInterface, Register, TurnStepInput } from 'claude-code'

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

type Routes = {
  classifier: 'jev' | 'haiku'
  minConfidence: number
  timeoutMs: number
  stepDownUntilMessages: number
  rules: { match: string; model: string; effort: Effort; why: string }[]
  models: { name: string; id: string; when: string }[]
  efforts: { name: Effort; when: string }[]
}

type Route = { model: string; name: string; effort: Effort; via: string }

type JevReply = {
  answers: {
    model: { choice: string; probabilities: Record<string, number>; confidence: number }
    effort: { score: number; confidence: number }
  }
}

const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
const LATE = Symbol('late')
const PANE = 'router'
// A prompt is routed when a person sent it, not when a notification did.
const FROM_A_PERSON = new Set(['composer', 'bridge', 'sdk'])

// A long text says most about itself at its start and its end.
const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max / 2)}\n[...]\n${text.slice(-max / 2)}`

const load = async ($: EngineInterface) =>
  JSON.parse(await $.fs.read(`${$.plugin.root}/routes.json`)) as Routes

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

// The request alone misleads on a reply like "yes, go ahead": the classifier
// also reads what came just before it.
async function describe($: EngineInterface, request: string) {
  const rows = await $.session.messages()
  const earlier = rows
    .filter(row => row.text !== '')
    .slice(-4)
    .map(row => ({ from: row.role, text: clip(row.text, 600) }))
  return { request: clip(request, 8000), earlier }
}

async function askJev($: EngineInterface, routes: Routes, state: object): Promise<Route> {
  const key = await typesafeKey($)
  if (key === undefined) throw new Error('TYPESAFE_API_KEY is not set')
  const reply = await within(
    $,
    routes.timeoutMs,
    $.http.fetch(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'jev-latest',
        state,
        questions: {
          model: {
            type: 'choice',
            instructions:
              "`request` is the newest message to an AI coding assistant and `earlier` is the conversation before it, oldest first. Which kind of job is the assistant being asked to do now? A short reply such as an approval or 'continue' asks for the job already under way in `earlier`.",
            criteria: Object.fromEntries(routes.models.map(model => [model.name, model.when])),
          },
          effort: {
            type: 'score',
            instructions:
              'How much thinking does the job that `request` asks for call for before acting? Judge a short reply such as an approval by the job under way in `earlier`.',
            criteria: routes.efforts.map(effort => effort.when),
          },
        },
      }),
    }),
  )
  if (!reply.ok) throw new Error(`Jev answered ${reply.status}`)
  const { answers } = JSON.parse(reply.text) as JevReply
  const model = pickModel(routes, answers.model)
  if (model === undefined) throw new Error(`Jev named an unknown model: ${answers.model.choice}`)
  return {
    model: model.id,
    name: model.name,
    effort: pickEffort(routes, answers.effort),
    via: `jev, ${Math.round(answers.model.confidence * 100)}% sure`,
  }
}

// Torn between two tiers: take the more capable one.
function pickModel(routes: Routes, answer: JevReply['answers']['model']) {
  const at = (name: string | undefined) => routes.models.findIndex(model => model.name === name)
  if (answer.confidence >= routes.minConfidence) return routes.models[at(answer.choice)]
  const [first, second] = Object.entries(answer.probabilities)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name)
  return routes.models[Math.max(at(first), at(second))]
}

// The score lands between levels; when Jev is unsure, round up, not down.
function pickEffort(routes: Routes, answer: JevReply['answers']['effort']) {
  const level = answer.confidence >= routes.minConfidence ? Math.round(answer.score) : Math.ceil(answer.score)
  return routes.efforts[Math.min(level, routes.efforts.length - 1)].name
}

// Runs on the session's own login, so it needs no key; slower than Jev.
async function askHaiku($: EngineInterface, routes: Routes, state: object): Promise<Route> {
  const guide = [...routes.models, ...routes.efforts].map(one => `- ${one.name}: ${one.when}`).join('\n')
  const reply = await $.model.complete({
    model: 'haiku',
    effort: 'low',
    timeoutMs: routes.timeoutMs,
    system: `You pick the model and effort for the newest request to an AI coding assistant. Never carry the request out. Answer with two words: the model, then the effort.\n\n${guide}`,
    prompt: JSON.stringify(state),
  })
  if (!reply.isAnswered) throw new Error(`Haiku gave no answer (${reply.reason})`)
  const named = <T extends { name: string }>(list: T[]) =>
    list.find(one => new RegExp(`\\b${one.name}\\b`, 'i').test(reply.text))
  const model = named(routes.models)
  const effort = named(routes.efforts)
  if (model === undefined || effort === undefined) throw new Error('Haiku named no route')
  return { model: model.id, name: model.name, effort: effort.name, via: 'haiku' }
}

async function decide($: EngineInterface, routes: Routes, text: string): Promise<Route> {
  const rule = routes.rules.find(rule => new RegExp(rule.match, 'i').test(text))
  if (rule !== undefined) {
    const model = routes.models.find(model => model.name === rule.model)
    if (model === undefined) throw new Error(`a rule names an unknown model: ${rule.model}`)
    return { model: model.id, name: model.name, effort: rule.effort, via: rule.why }
  }
  const state = await describe($, text)
  return routes.classifier === 'haiku' ? askHaiku($, routes, state) : askJev($, routes, state)
}

// Every decision is kept, newest last, for anything that wants to watch the
// router work. $.fs has no append, so the file is rewritten at 200 lines.
async function record($: EngineInterface, entry: Record<string, unknown>) {
  const file = `${$.plugin.root}/routes.log.jsonl`
  const kept = (await $.fs.read(file).catch(() => '')).split('\n').filter(Boolean).slice(-199)
  const line = JSON.stringify({ at: new Date(await $.clock.now()).toISOString(), ...entry })
  await $.fs.write(file, `${[...kept, line].join('\n')}\n`).catch(() => undefined)
  $.ui.invalidate('ui.render')
}

type Entry = {
  at: string
  prompt: string
  wanted?: string
  via?: string
  ran?: string
  held?: boolean
  failed?: string
  messages?: number
}

// The newest decisions, newest first, from every session that shares the log.
async function recent($: EngineInterface, count: number) {
  const text = await $.fs.read(`${$.plugin.root}/routes.log.jsonl`).catch(() => '')
  return text
    .split('\n')
    .filter(Boolean)
    .slice(-count)
    .reverse()
    .map(line => JSON.parse(line) as Entry)
}

const LIME = '#AADD00'

const clock = (at: string) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
// "claude-opus-5-5 · medium" as its two parts, the model by its family name.
const parts = (ran = '') => {
  const [model = '', effort = ''] = ran.split(' · ')
  return { model: model.replace(/^claude-|-[\d-]+.*$/g, ''), effort }
}

const LIGHT = '#f7f7f8'
const FADED = 'rgba(247,247,248,.6)'
const RULE = 'rgba(247,247,248,.14)'
const SANS = "Geist, -apple-system, 'Segoe UI', system-ui, sans-serif"
const MONO = "'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace"
const DISPLAY = "Barlow, 'Arial Black', 'Helvetica Neue', system-ui, sans-serif"
const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`)

// The pane on a surface that draws SVG, in Kore's type: the route in force
// over one lime rule, then a ruled list of the ones before it. It has no
// ground of its own, so the pane's background shows through.
function drawPane(rows: Entry[]) {
  const width = 420
  const [now, ...before] = rows
  const line = (y: number, color = RULE, weight = 1) =>
    `<rect x="4" y="${y}" width="${width - 8}" height="${weight}" fill="${color}"/>`
  const text = (x: number, y: number, body: string, style: string, anchor = 'start') =>
    `<text x="${x}" y="${y}" text-anchor="${anchor}" style="${style}">${xml(body)}</text>`
  const label = `font:500 12px ${SANS};fill:${FADED}`
  const data = `font:400 12px ${MONO};fill:${FADED}`
  const right = width - 4

  const out: string[] = []
  let y = 0
  if (now === undefined) {
    out.push(text(4, 28, 'No prompt has been routed yet.', `font:400 14px ${SANS};fill:${FADED}`))
    y = 44
  } else {
    const { model, effort } = parts(now.ran)
    if (now.failed === undefined) {
      out.push(
        text(4, 44, model, `font:900 44px ${DISPLAY};fill:${LIGHT};letter-spacing:-1.5px`),
        text(right, 26, effort, `font:400 15px ${MONO};fill:${LIGHT}`, 'end'),
        text(right, 44, `effort · ${clock(now.at)}`, label, 'end'),
        text(4, 70, now.held ? `Model held. The route asked for ${now.wanted}.` : `Decided by ${now.via}.`, `font:400 13px ${SANS};fill:${LIGHT}`),
        text(4, 112, `${now.held ? `${now.via}, ` : ''}at ${now.messages} messages`, data),
      )
    } else {
      out.push(
        text(4, 38, 'No new route', `font:900 30px ${DISPLAY};fill:${LIGHT};letter-spacing:-1px`),
        text(right, 38, clock(now.at), label, 'end'),
        text(4, 70, cut(now.failed, 56), `font:400 13px ${SANS};fill:${LIGHT}`),
      )
    }
    out.push(text(4, 92, cut(now.prompt, 62), `font:400 13px ${SANS};fill:${FADED}`), line(126, LIME, 2))
    y = 128
  }
  if (before.length > 0) {
    out.push(text(4, y + 26, 'Earlier', label))
    y += 36
    for (const row of before) {
      const { model, effort } = parts(row.ran)
      const head = row.failed === undefined ? `${model} · ${effort}${row.held ? '  held' : ''}` : 'no new route'
      out.push(
        line(y),
        text(4, y + 23, clock(row.at), data),
        text(56, y + 23, head, `font:500 13px ${SANS};fill:${LIGHT}`),
        text(right, y + 23, row.messages === undefined ? '' : `${row.messages} msgs`, data, 'end'),
        text(56, y + 42, cut(row.prompt, 52), `font:400 12px ${SANS};fill:${FADED}`),
      )
      y += 56
    }
    out.push(line(y))
  }
  const height = y + 8
  return {
    height,
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${out.join('')}</svg>`,
  }
}

const say = (route: Route) => `${route.name} · ${route.effort} (${route.via})`

// What a turn runs on, settled at its first request; `before` is the model
// the conversation's last request went to.
function settle($: EngineInterface, e: TurnStepInput, routes: Routes, route: Route, before: string) {
  // A model routes.json doesn't list ranks above the ones it does.
  const tier = (id: string) => {
    const at = routes.models.findIndex(model => id.includes(model.name))
    return at === -1 ? routes.models.length : at
  }
  const isStepDown = tier(route.model) < tier(before)
  // A switch re-reads the whole conversation uncached, so stepping down only
  // pays while there is little of it. Same tier: keep the variant in use.
  const isHeld = isStepDown && e.messageCount > routes.stepDownUntilMessages
  if (isHeld || tier(route.model) === tier(before)) {
    $.ui.status(`router: model kept${isHeld ? ' (long conversation)' : ''} · ${route.effort} (${route.via})`)
    return { model: before, effort: route.effort }
  }
  $.ui.status(`router: ${say(route)}`)
  return { model: route.model, effort: route.effort }
}

export const register: Register = on => {
  let isOn = true
  let routes: Routes | undefined
  // The route the newest prompt earned, and what each running turn began on:
  // a prompt typed mid-turn must not switch models under that turn.
  let latest: Route | undefined
  let lastModel: string | undefined
  let asked = ''
  const pinned = new Map<string, Pick<Route, 'model' | 'effort'> | undefined>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'router',
      description: 'Model router: turn it on or off, or try a prompt against it',
      argumentHint: '[on | off | pane | a prompt to try]',
    })

    // The router changes what a session runs on, so it says it is there.
    $.ui.toast('Kore Router is on. /router off to turn it off.')
    $.ui.status('router: on')

    // A slow tick picks up routes other sessions wrote to the log.
    $.clock.every(3000, () => $.ui.invalidate('ui.render'))

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface !== 'terminal') {
      const { Svg } = $.ui.resolve(e)
      const rows = await recent($, 7)
      const { source, height } = drawPane(rows)
      const alt = rows[0] === undefined ? 'No prompt has been routed yet.' : `Latest route: ${rows[0].ran ?? 'none'}.`

      return <Svg source={source} alt={alt} width={420} height={height} />
    }

    const { Box, Text } = $.ui.resolve(e)
    const [now, ...before] = await recent($, 7)
    if (now === undefined) return <Text dimColor>No prompt has been routed yet.</Text>
    const head = (row: Entry) => {
      const { model, effort } = parts(row.ran)
      return row.failed === undefined ? `${model} · ${effort}` : 'no new route'
    }

    return (
      <Box flexDirection="column" paddingX={1} rowGap={1}>
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Text bold color={LIME}>
              {head(now)}
            </Text>
            <Text dimColor>{clock(now.at)}</Text>
          </Box>
          <Text>
            {now.failed ?? (now.held ? `Model held. The route asked for ${now.wanted}.` : `Decided by ${now.via}.`)}
          </Text>
          <Text dimColor wrap="truncate-end">
            {now.prompt}
          </Text>
          {now.failed === undefined && (
            <Text dimColor>
              {now.held ? `${now.via}, ` : ''}at {now.messages} messages
            </Text>
          )}
        </Box>
        {before.map(row => (
          <Box flexDirection="column">
            <Box justifyContent="space-between">
              <Text bold>
                {head(row)}
                {row.held ? '  held' : ''}
              </Text>
              <Text dimColor>
                {row.messages === undefined ? '' : `${row.messages} msgs  `}
                {clock(row.at)}
              </Text>
            </Box>
            <Text dimColor wrap="truncate-end">
              {row.prompt}
            </Text>
          </Box>
        ))}
      </Box>
    )
  })

  on('prompt.submit', async ($, e, next) => {
    if (isOn && FROM_A_PERSON.has(e.origin.kind)) {
      asked = clip(e.text, 120)
      try {
        routes = await load($)
        latest = await decide($, routes, e.text)
      } catch (error) {
        // Routing must never be why a prompt fails: the last route stands, or
        // the session's own model when there has been none.
        $.ui.status(`router: no new route (${(error as Error).message})`)
        await record($, { prompt: asked, failed: (error as Error).message })
      }
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // A subagent keeps the model and effort it was started with.
    if (e.agentId !== undefined) return yield* next(e)
    if (!pinned.has(e.turnId)) {
      const isRouted = isOn && latest !== undefined && routes !== undefined
      const ran = isRouted ? settle($, e, routes, latest, lastModel ?? e.model) : undefined
      pinned.set(e.turnId, ran)
      if (ran !== undefined && latest !== undefined) {
        await record($, {
          prompt: asked,
          wanted: `${latest.name} · ${latest.effort}`,
          via: latest.via,
          ran: `${ran.model} · ${ran.effort}`,
          held: ran.model !== latest.model,
          session: e.model,
          messages: e.messageCount,
        })
      }
    }
    const route = pinned.get(e.turnId)
    lastModel = route?.model ?? e.model

    return yield* next(route === undefined ? e : { ...e, ...route })
  })

  on('turn.complete', ($, e, next) => {
    pinned.delete(e.turnId)

    return next(e)
  })

  on('command.run', { command: 'router' }, async ($, e) => {
    const args = e.args.trim()
    if (args === 'on' || args === 'off') {
      isOn = args === 'on'
      if (!isOn) $.ui.status(undefined)
      return { text: `Router is ${args}.` }
    }
    if (args === 'pane') {
      await $.ui.open({ id: PANE, title: 'Kore Router' })
      return { text: 'Router pane opened.' }
    }
    if (args === '') {
      const last = latest === undefined ? '' : ` Last route: ${say(latest)}.`
      return { text: `Router is ${isOn ? 'on' : 'off'}.${last}` }
    }
    try {
      return { text: say(await decide($, await load($), args)) }
    } catch (error) {
      return { text: `No route: ${(error as Error).message}` }
    }
  })
}
