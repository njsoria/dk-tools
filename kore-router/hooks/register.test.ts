import type { On, TurnStepInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const PRICING = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 4 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 },
}

// Each task asks for the lowest effort, so the classifier's effort shows
// through, except `risky`, whose own effort is the floor.
const ROUTES = {
  classifier: 'jev',
  minConfidence: 0.5,
  timeoutMs: 5000,
  pricing: PRICING,
  switching: { expectedSteps: 8, expectedOutput: 5000, cacheTtlMinutes: 60, margin: 1.5 },
  guards: { pushback: "^\\W*(that'?s wrong|try again)", followUp: '^\\W*(yes|go ahead)[\\s,.!]*$', shortWords: 2, holdTurns: 2, toolErrors: 3 },
  subagents: { classify: true, types: { Explore: 'lookup' } },
  rules: [
    { match: '\\bultrathink\\b', model: 'opus', effort: 'max', why: 'asked for maximum thinking' },
    { match: '\\bprod\\b', model: 'opus', effort: 'high', atLeast: true, why: 'it touches something risky' },
  ],
  tasks: [
    { name: 'answer', model: 'haiku', effort: 'low', when: 'quick' },
    { name: 'lookup', model: 'haiku', effort: 'medium', when: 'reading' },
    { name: 'build', model: 'sonnet', effort: 'low', when: 'ordinary' },
    { name: 'design', model: 'opus', effort: 'low', when: 'hard' },
    { name: 'risky', model: 'opus', effort: 'xhigh', when: 'costly mistakes' },
  ],
  models: [
    { name: 'haiku', id: 'claude-haiku-5-5', maxContext: 100_000 },
    { name: 'sonnet', id: 'claude-sonnet-5-5' },
    { name: 'opus', id: 'claude-opus-5-5' },
  ],
  efforts: [
    { name: 'low', when: 'immediate' },
    { name: 'medium', when: 'a few steps' },
    { name: 'high', when: 'trade-offs' },
    { name: 'xhigh', when: 'hard' },
  ],
}

type Classifier = { status?: number; answers?: unknown; haiku?: string; routes?: object; files?: Record<string, string> }

// The world beneath the router: its files, a quiet session, the classifier's
// answer, and a model that records what each request asked for and reports
// `usage.context` tokens read from its cache.
function world(on: On, { status = 200, answers = {}, haiku = '', routes = ROUTES, files = {} }: Classifier = {}) {
  const sent: TurnStepInput[] = []
  const spawned: { subagentType: string; model?: string }[] = []
  const usage = { context: 0 }
  // Files by the end of their path, as the router left or will find them.
  const find = (path: string) => Object.keys(files).find(name => path.endsWith(name))
  const asked = { jev: 0, haiku: 0 }
  let answer = answers
  mock.env(on, { TYPESAFE_API_KEY: 'test-key' })
  mock.clock(on)
  on('fs.read', ($, e) => {
    if (e.path.endsWith('routes.json')) return { value: JSON.stringify(routes) }
    const name = find(e.path)
    return name === undefined ? { deny: 'no such file' } : { value: files[name]! }
  })
  on('fs.list', ($, e) => ({
    value: Object.keys(files)
      .filter(name => name.startsWith('logs/') && e.path.endsWith('logs'))
      .map(name => ({ name: name.slice('logs/'.length), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('session.messages', () => ({ value: [] }))
  on('session.id', () => ({ value: 'this-session' }))
  on('fs.write', ($, e) => {
    files[find(e.path) ?? e.path.slice(e.path.lastIndexOf('logs/'))] = e.text
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('http.fetch', () => {
    asked.jev += 1
    return { value: { status, ok: status === 200, headers: {}, text: JSON.stringify({ answers: answer }) } }
  })
  on('model.complete', () => {
    asked.haiku += 1
    const none = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    return { value: { isAnswered: true, text: haiku, usage: none } }
  })
  on('agent.spawn', ($, e) => {
    spawned.push({ subagentType: e.subagentType, model: e.model })
    return { model: e.model ?? 'inherit', agentId: `agent-${spawned.length}` }
  })
  on('tool.call', () => ({ isError: true as const, text: 'exit 1', result: undefined }))
  on('turn.step', async function* ($, e) {
    sent.push(e)
    const counts = { input_tokens: 0, output_tokens: 1000, cache_read_input_tokens: usage.context, cache_creation_input_tokens: 0, model: e.model }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: counts }
  })
  // The classifier's next answer, for a test that asks it more than once.
  const answering = (next: unknown) => {
    answer = next
  }
  return { sent, asked, files, spawned, usage, answering }
}

const jev = (choice: string, confidence: number, score: number, probabilities: Record<string, number> = { [choice]: 1 }) => ({
  task: { choice, confidence, probabilities },
  effort: { score, confidence },
})

let turns = 0

async function step($: Engine, request: Partial<TurnStepInput> = {}) {
  const stream = $.turn.step({ turnId: `turn-${turns++}`, index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 2, ...request })
  for await (const _ of stream) {
    // the test's model answers nothing
  }
}

async function ask($: Engine, text: string, request: Partial<TurnStepInput> = {}) {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
  await step($, request)
}

// What the Agent tool hands agent.spawn, less what each test says.
const spawn = ($: Engine, call: { prompt: string; subagentType: string; description?: string; model?: string }) =>
  $.agent.spawn({
    tool_use_id: 'tool-1',
    description: '',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
    ...call,
  })

const run = ($: Engine, args: string) =>
  $.command.run({ command: 'router', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

test('a rule routes without asking the classifier', async ($, on) => {
  const { sent, asked } = world(on)
  await ask($, 'ultrathink about the billing schema', { model: 'claude-sonnet-5-5' })
  expect(sent[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'max' })
  expect(asked).toEqual({ jev: 0, haiku: 0 })
})

test("Jev's task rides on the turn's request", async ($, on) => {
  const { sent } = world(on, { answers: jev('build', 0.9, 1.2) })
  await ask($, 'add a --json flag')
  expect(sent[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' })
})

test("a task's own effort is the least it runs at", async ($, on) => {
  const { sent } = world(on, { answers: jev('risky', 0.9, 0) })
  await ask($, 'rotate the signing keys')
  expect(sent[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'xhigh' })
})

test('an unsure answer leans to the task on the more capable model and the higher effort', async ($, on) => {
  const { sent } = world(on, { answers: jev('answer', 0.2, 1.2, { answer: 0.45, build: 0.4, design: 0.15 }) })
  await ask($, 'look into the flaky checkout test')
  expect(sent[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' })
})

test('an atLeast rule raises what the classifier answers, after asking it', async ($, on) => {
  const { sent, asked } = world(on, { answers: jev('answer', 0.9, 0) })
  await ask($, 'what does the prod config set?')
  expect(sent[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
  expect(asked.jev).toBe(1)
})

test("the harness's own notes are no part of the prompt", async ($, on) => {
  const { sent } = world(on, { answers: jev('build', 0.9, 0) })
  await ask($, '<system-reminder>\nultrathink\n</system-reminder>\nadd a --json flag')
  expect(sent[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low' })
})

test('a short follow-up keeps the route in force without asking the classifier', async ($, on) => {
  const { sent, asked } = world(on, { answers: jev('design', 0.9, 2) })
  await ask($, 'plan how the exporter should page through results')
  await ask($, 'yes')
  expect(asked.jev).toBe(1)
  expect(sent[1]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
})

test('a prompt too short to classify keeps the route in force, still raised by an atLeast rule', async ($, on) => {
  const { sent, asked } = world(on, { answers: jev('answer', 0.9, 0) })
  await ask($, 'what does git stash pop do?')
  await ask($, 'router pane')
  await ask($, 'check prod')
  expect(asked.jev).toBe(1)
  expect(sent[1]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low' })
  expect(sent[2]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
})

test('a short question is still classified', async ($, on) => {
  const { asked } = world(on, { answers: jev('answer', 0.9, 0) })
  await ask($, 'what does git stash pop do?')
  await ask($, 'why flaky?')
  expect(asked.jev).toBe(2)
})

test('a failed classifier leaves the request as the session set it', async ($, on) => {
  const { sent } = world(on, { status: 401 })
  await ask($, 'add a --json flag')
  expect(sent[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
})

test("a step down that saves more than the switch costs happens, however long the conversation", async ($, on) => {
  const { sent, usage } = world(on, { answers: jev('answer', 0.9, 0) })
  usage.context = 50_000
  await step($, { messageCount: 590 })
  await ask($, 'what does git stash pop do?', { messageCount: 600 })
  expect(sent[1]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low' })
})

test("a step down that wouldn't pay for its cache keeps the model and still takes the effort", async ($, on) => {
  const { sent, usage, files } = world(on, { answers: jev('build', 0.9, 0) })
  usage.context = 50_000
  await step($, { messageCount: 590 })
  await ask($, 'add a --json flag', { messageCount: 600 })
  expect(sent[1]).toMatchObject({ model: 'claude-opus-5-5', effort: 'low' })
  expect(files['logs/this-session.routes.jsonl']).toContain('model kept: switching would cost')
})

test('without prices, a long conversation keeps its model', async ($, on) => {
  const { sent } = world(on, { answers: jev('answer', 0.9, 0), routes: { ...ROUTES, pricing: undefined } })
  await ask($, 'what does git stash pop do?', { messageCount: 200 })
  expect(sent[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'low' })
})

test('more context than a model is trusted with keeps a stronger one', async ($, on) => {
  const { sent, usage } = world(on, { answers: jev('answer', 0.9, 0) })
  usage.context = 150_000
  await step($, { model: 'claude-sonnet-5-5' })
  await ask($, 'what does git stash pop do?', { model: 'claude-sonnet-5-5' })
  expect(sent[1]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low' })
})

test('the same tier keeps the variant the session is on', async ($, on) => {
  const { sent } = world(on, { answers: jev('design', 0.9, 3) })
  await ask($, 'design the migration', { model: 'claude-opus-5-5[1m]' })
  expect(sent[0]).toMatchObject({ model: 'claude-opus-5-5[1m]', effort: 'xhigh' })
})

test('a pushback runs the next prompts a tier above the turn it answers, then lifts', async ($, on) => {
  const { sent } = world(on, { answers: jev('answer', 0.9, 0) })
  await ask($, 'what does git stash pop do?')
  await ask($, "that's wrong, it drops the stash")
  await ask($, 'and git stash apply?')
  await ask($, 'and git stash list?')
  expect(sent.map(request => request.model)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])
})

test('a turn that keeps failing moves up a tier for the rest of it', async ($, on) => {
  const { sent } = world(on, { answers: jev('build', 0.9, 0) })
  await $.prompt.submit({ text: 'add a --json flag', wait: false, origin: { kind: 'composer' } })
  const turn = { turnId: 'struggling', model: 'claude-opus-5-5', messageCount: 2 }
  const drain = async (index: number) => {
    for await (const _ of $.turn.step({ ...turn, index })) {
      // nothing to read
    }
  }
  await drain(0)
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'false' })
  await drain(1)
  expect(sent.map(request => request.model)).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5'])
})

test('/router floor holds a session at a model until lifted', async ($, on) => {
  const { sent } = world(on, { answers: jev('answer', 0.9, 0) })
  await run($, 'floor sonnet')
  await ask($, 'what does git stash pop do?')
  await run($, 'floor off')
  await ask($, 'what does git stash list do?')
  expect(sent.map(request => request.model)).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5'])
})

test("an escalation that runs out leaves the person's own floor standing", async ($, on) => {
  const { sent } = world(on, { answers: jev('answer', 0.9, 0) })
  await run($, 'floor sonnet')
  await ask($, 'what does git stash pop do?')
  await ask($, "that's wrong, it drops the stash")
  await ask($, 'and git stash apply?')
  await ask($, 'and git stash list?')
  expect(sent.map(request => request.model)).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'])
})

test("a notification's turn stays on the last person's route", async ($, on) => {
  const { sent, asked } = world(on, { answers: jev('build', 0.9, 2) })
  await ask($, 'refactor the session reader')
  await $.prompt.submit({ text: 'Agent finished', wait: false, origin: { kind: 'task-notification' } })
  await step($)
  expect(asked.jev).toBe(1)
  expect(sent[1]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' })
})

test('a subagent of a listed type starts on its task, and its steps take its effort', async ($, on) => {
  const { sent, spawned, asked } = world(on)
  const { agentId } = await spawn($, { prompt: 'find where sessions are read', description: 'find session reader', subagentType: 'Explore' })
  await step($, { agentId, model: 'claude-haiku-5-5', effort: 'high' })
  expect(spawned[0]).toMatchObject({ subagentType: 'Explore', model: 'claude-haiku-5-5' })
  expect(sent[0]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'medium' })
  expect(asked.jev).toBe(0)
})

test('any other subagent is classified on its own task', async ($, on) => {
  const { spawned } = world(on, { answers: jev('design', 0.9, 2) })
  await spawn($, { prompt: 'plan the storage migration', description: 'plan migration', subagentType: 'general-purpose' })
  expect(spawned[0]).toMatchObject({ model: 'claude-opus-5-5' })
})

test("a subagent's named model is kept when it is stronger, raised when it is weaker", async ($, on) => {
  const { spawned } = world(on, { answers: jev('build', 0.9, 0) })
  await spawn($, { prompt: 'review this diff', subagentType: 'general-purpose', model: 'opus' })
  await spawn($, { prompt: 'write the migration', subagentType: 'general-purpose', model: 'haiku' })
  expect(spawned.map(one => one.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
})

test('a subagent the router did not start keeps the model it was started with', async ($, on) => {
  const { sent } = world(on, { answers: jev('answer', 0.9, 0) })
  await ask($, 'what does git stash pop do?', { agentId: 'agent-1', model: 'claude-sonnet-5-5', effort: 'medium' })
  expect(sent[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' })
})

test('Haiku classifies when routes.json asks for it', async ($, on) => {
  const { sent, asked } = world(on, { routes: { ...ROUTES, classifier: 'haiku' }, haiku: 'build xhigh' })
  await ask($, 'add a --json flag')
  expect(sent[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'xhigh' })
  expect(asked).toEqual({ jev: 0, haiku: 1 })
})

test('/router off hands the session back', async ($, on) => {
  const { sent } = world(on, { answers: jev('answer', 0.9, 0) })
  await ask($, 'what does git stash pop do?')
  await run($, 'off')
  await step($)
  expect(sent[0]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low' })
  expect(sent[1]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
})

test('a mistake in routes.json is reported, not run', async ($, on) => {
  const { sent } = world(on, { answers: jev('answer', 0.9, 0), routes: { ...ROUTES, tasks: [{ name: 'answer', model: 'gpt', effort: 'low', when: 'quick' }] } })
  await ask($, 'what does git stash pop do?')
  expect(sent[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
})

test('a session keeps every decision in a file of its own', async ($, on) => {
  const { files } = world(on, { answers: jev('build', 0.9, 1.2) })
  for (let i = 0; i < 205; i++) await ask($, `add flag number ${i}`)
  expect(Object.keys(files)).toEqual(['logs/this-session.routes.jsonl'])
  expect(files['logs/this-session.routes.jsonl']!.trim().split('\n')).toHaveLength(205)
})

test('/router savings adds up every session', async ($, on) => {
  const price = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }
  const turn = (sessionId: string, at: string) =>
    `${JSON.stringify({ at, sessionId, prompt: 'p', session: 'claude-opus-5-5', ran: 'claude-haiku-5-5', tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } })}\n`
  world(on, {
    routes: { ...ROUTES, pricing: { 'claude-haiku-5-5': price, 'claude-opus-5-5': { ...price, input: 5 } } },
    files: {
      'routes.spend.jsonl': turn('old', '2026-10-01T00:00:00.000Z'),
      'logs/one.spend.jsonl': turn('one', '2026-10-02T00:00:00.000Z') + turn('one', '2026-10-03T00:00:00.000Z'),
      'logs/two.spend.jsonl': turn('two', '2026-10-04T00:00:00.000Z'),
      'logs/two.routes.jsonl': '{"at":"2026-10-04T00:00:00.000Z","prompt":"p"}\n',
    },
  })
  const { text } = await run($, 'savings')
  expect(text).toContain('since 2026-10-01, over 4 turns')
  expect(text).toContain('router $4.00  vs  $20.00')
  expect(text).toContain('ran on: haiku 4 ($4.00)')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a collapsed row shows only the first line of its prompt (${surface})`, async ($, on) => {
    world(on, { answers: jev('build', 0.9, 1.2) })
    await ask($, 'add a --json flag\nyes since it hits a zoho line\nyes they should be turned off')
    const pane = await $.ui.mount({
      plugin: 'kore-model-router',
      surface,
      component: 'Pane',
      requestId: 'router',
      props: { title: 'Kore Model Router', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    })
    expect(await pane.find({ text: 'add a --json flag' })).toBeDefined()
    expect(await pane.find({ text: /zoho/ })).toBeUndefined()
    const [toggle] = await pane.findAll({ type: 'Button', text: /sonnet · medium/ })
    await pane.press({ key: toggle!.key! })
    expect(await pane.find({ text: /zoho/ })).toBeDefined()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane's rows open to every field and close again (${surface})`, async ($, on) => {
    world(on, { answers: jev('build', 0.9, 1.2) })
    await ask($, 'add a --json flag to the export command so the CI job can read its output')
    const pane = await $.ui.mount({
      plugin: 'kore-model-router',
      surface,
      component: 'Pane',
      requestId: 'router',
      props: { title: 'Kore Model Router', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    })
    const [toggle] = await pane.findAll({ type: 'Button', text: /sonnet · medium/ })
    expect(await pane.find({ text: 'Decided by:' })).toBeUndefined()
    await pane.press({ key: toggle!.key! })
    expect(await pane.find({ text: 'Decided by:' })).toBeDefined()
    expect(await pane.find({ text: /jev, build, 90% sure/ })).toBeDefined()
    expect(await pane.find({ text: 'add a --json flag to the export command so the CI job can read its output' })).toBeDefined()
    await pane.press({ key: 'close-all' })
    expect(await pane.find({ text: 'Decided by:' })).toBeUndefined()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`clicking the router's line under the prompt opens its pane, and again closes it (${surface})`, async ($, on) => {
    world(on, { answers: jev('build', 0.9, 1.2) })
    const opened: string[] = []
    const closed: string[] = []
    on('ui.open', ($, e) => {
      opened.push(e.id)
      return { value: { isPlaced: true as const } }
    })
    on('ui.close', ($, e) => {
      closed.push(e.id)
      return { value: undefined }
    })
    on('ui.panes', () => ({
      value: opened.length > closed.length ? [{ id: 'router', title: 'Kore Model Router', isShown: true, isFocused: true, isPlaced: true }] : [],
    }))
    // The engine's own hint line, which the router's sits beside.
    on('ui.render', { component: 'PromptHint' }, ($, e) => $.ui.resolve(e).Text({ dimColor: true, children: e.props.hint }))
    await ask($, 'add a --json flag')
    const hint = await $.ui.mount({
      plugin: 'kore-model-router',
      surface,
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
    })
    expect((await hint.find({ key: 'router-line' }))?.props).toMatchObject({ label: 'router: sonnet · medium' })
    expect(await hint.find({ text: '? for shortcuts' })).toBeDefined()
    await hint.press({ key: 'router-line' })
    expect(opened).toEqual(['router'])
    await hint.press({ key: 'router-line' })
    expect(closed).toEqual(['router'])
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the line under the prompt follows each new route (${surface})`, async ($, on) => {
    const { answering } = world(on, { answers: jev('build', 0.9, 1.2) })
    on('ui.render', { component: 'PromptHint' }, ($, e) => $.ui.resolve(e).Text({ dimColor: true, children: e.props.hint }))
    await ask($, 'add a --json flag')
    const hint = await $.ui.mount({
      plugin: 'kore-model-router',
      surface,
      component: 'PromptHint',
      props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
    })
    expect((await hint.find({ key: 'router-line' }))?.props).toMatchObject({ label: 'router: sonnet · medium' })
    answering(jev('design', 0.95, 2))
    await ask($, 'the export crashes on an empty table, find out why')
    expect((await hint.find({ key: 'router-line' }))?.props).toMatchObject({ label: expect.stringMatching(/^router: opus/) })
  })
}

test('the desktop shows the route under its input bar, beside the mode labels, and follows each new route', async ($, on) => {
  const { answering } = world(on, { answers: jev('build', 0.9, 1.2) })
  const opened: string[] = []
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.panes', () => ({ value: [] }))
  // The engine's own mode labels, which the router's button sits beside.
  on('ui.render', { component: 'SessionMode' }, ($, e) => $.ui.resolve(e).Text({ dimColor: true, children: e.props.modes.join(' & ') }))
  await ask($, 'add a --json flag')
  const footer = await $.ui.mount({
    plugin: 'kore-model-router',
    surface: 'desktop',
    component: 'SessionMode',
    props: { modes: ['focus'] },
  })
  expect((await footer.find({ key: 'router-line' }))?.props).toMatchObject({ label: 'router: sonnet · medium' })
  expect(await footer.find({ text: 'focus' })).toBeDefined()
  await footer.press({ key: 'router-line' })
  expect(opened).toEqual(['router'])
  answering(jev('design', 0.95, 2))
  await ask($, 'the export crashes on an empty table, find out why')
  expect((await footer.find({ key: 'router-line' }))?.props).toMatchObject({ label: expect.stringMatching(/^router: opus/) })
})

test("the terminal's mode labels are left to the engine, since its hint line shows the route", async ($, on) => {
  world(on, { answers: jev('build', 0.9, 1.2) })
  on('ui.render', { component: 'SessionMode' }, ($, e) => $.ui.resolve(e).Text({ dimColor: true, children: e.props.modes.join(' & ') }))
  await ask($, 'add a --json flag')
  const footer = await $.ui.mount({
    plugin: 'kore-model-router',
    surface: 'terminal',
    component: 'SessionMode',
    props: { modes: ['focus'] },
  })
  expect(await footer.find({ key: 'router-line' })).toBeUndefined()
  expect(await footer.find({ text: 'focus' })).toBeDefined()
})

test('/router open opens the pane, as /router pane does', async ($, on) => {
  world(on)
  const opened: string[] = []
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  const { text } = await run($, 'open')
  expect(text).toBe('Router pane opened.')
  expect(opened).toEqual(['router'])
})
