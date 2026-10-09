import type { On, TurnStepInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const ROUTES = {
  classifier: 'jev',
  minConfidence: 0.5,
  timeoutMs: 5000,
  stepDownUntilMessages: 30,
  rules: [{ match: '\\bultrathink\\b', model: 'opus', effort: 'max', why: 'asked for maximum thinking' }],
  models: [
    { name: 'haiku', id: 'claude-haiku-5-5', when: 'quick' },
    { name: 'sonnet', id: 'claude-sonnet-5-5', when: 'ordinary' },
    { name: 'opus', id: 'claude-opus-5-5', when: 'hard' },
  ],
  efforts: [
    { name: 'low', when: 'immediate' },
    { name: 'medium', when: 'a few steps' },
    { name: 'high', when: 'trade-offs' },
    { name: 'xhigh', when: 'hard' },
  ],
}

type Classifier = { status?: number; answers?: unknown; haiku?: string; routes?: object }

// The world beneath the router: its files, a quiet session, the classifier's
// answer, and a model that records what each request asked for.
function world(on: On, { status = 200, answers = {}, haiku = '', routes = ROUTES }: Classifier = {}) {
  const sent: TurnStepInput[] = []
  const asked = { jev: 0, haiku: 0 }
  mock.env(on, { TYPESAFE_API_KEY: 'test-key' })
  mock.clock(on)
  on('fs.read', ($, e) =>
    e.path.endsWith('routes.json') ? { value: JSON.stringify(routes) } : { deny: 'no such file' },
  )
  on('session.messages', () => ({ value: [] }))
  on('session.id', () => ({ value: 'this-session' }))
  on('fs.write', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('http.fetch', () => {
    asked.jev += 1
    return { value: { status, ok: status === 200, headers: {}, text: JSON.stringify({ answers }) } }
  })
  on('model.complete', () => {
    asked.haiku += 1
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    return { value: { isAnswered: true, text: haiku, usage } }
  })
  on('turn.step', async function* ($, e) {
    sent.push(e)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
  })
  return { sent, asked }
}

const jev = (choice: string, confidence: number, score: number, probabilities: Record<string, number> = { [choice]: 1 }) => ({
  model: { choice, confidence, probabilities },
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

test('a rule routes without asking the classifier', async ($, on) => {
  const { sent, asked } = world(on)
  await ask($, 'ultrathink about the billing schema', { model: 'claude-sonnet-5-5' })
  expect(sent[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'max' })
  expect(asked).toEqual({ jev: 0, haiku: 0 })
})

test("Jev's answer rides on the turn's request", async ($, on) => {
  const { sent } = world(on, { answers: jev('sonnet', 0.9, 1.2) })
  await ask($, 'add a --json flag')
  expect(sent[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' })
})

test('an unsure answer leans to the more capable model and the higher effort', async ($, on) => {
  const { sent } = world(on, { answers: jev('haiku', 0.2, 1.2, { haiku: 0.45, sonnet: 0.4, opus: 0.15 }) })
  await ask($, 'look into the flaky checkout test')
  expect(sent[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' })
})

test('a failed classifier leaves the request as the session set it', async ($, on) => {
  const { sent } = world(on, { status: 401 })
  await ask($, 'add a --json flag')
  expect(sent[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
})

test('a long conversation keeps its model and still takes the effort', async ($, on) => {
  const { sent } = world(on, { answers: jev('haiku', 0.9, 0) })
  await ask($, 'what does git stash pop do?', { messageCount: 200 })
  expect(sent[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'low' })
})

test('the same tier keeps the variant the session is on', async ($, on) => {
  const { sent } = world(on, { answers: jev('opus', 0.9, 3) })
  await ask($, 'design the migration', { model: 'claude-opus-5-5[1m]' })
  expect(sent[0]).toMatchObject({ model: 'claude-opus-5-5[1m]', effort: 'xhigh' })
})

test("a notification's turn stays on the last person's route", async ($, on) => {
  const { sent, asked } = world(on, { answers: jev('sonnet', 0.9, 2) })
  await ask($, 'refactor the session reader')
  await $.prompt.submit({ text: 'Agent finished', wait: false, origin: { kind: 'task-notification' } })
  await step($)
  expect(asked.jev).toBe(1)
  expect(sent[1]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' })
})

test('a subagent keeps the model it was started with', async ($, on) => {
  const { sent } = world(on, { answers: jev('haiku', 0.9, 0) })
  await ask($, 'what does git stash pop do?', { agentId: 'agent-1', model: 'claude-sonnet-5-5', effort: 'medium' })
  expect(sent[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' })
})

test('Haiku classifies when routes.json asks for it', async ($, on) => {
  const { sent, asked } = world(on, { routes: { ...ROUTES, classifier: 'haiku' }, haiku: 'sonnet xhigh' })
  await ask($, 'add a --json flag')
  expect(sent[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'xhigh' })
  expect(asked).toEqual({ jev: 0, haiku: 1 })
})

test('/router off hands the session back', async ($, on) => {
  const { sent } = world(on, { answers: jev('haiku', 0.9, 0) })
  await ask($, 'what does git stash pop do?')
  await $.command.run({ command: 'router', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  await step($)
  expect(sent[0]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low' })
  expect(sent[1]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
})
