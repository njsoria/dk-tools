import { expect, test } from 'claude-code/testing'
import { type Routes, check, dataDir, ownRoutes, versionsDir } from './config'

const COPY = '/Users/sam/.claude/plugins/cache/dk-tools/kore-model-router/0.4.0'

test("an installed copy keeps its logs and routes.json in Claude Code's data folder for the plugin", () => {
  expect(dataDir(COPY)).toBe('/Users/sam/.claude/plugins/data/kore-model-router-dk-tools')
  expect(dataDir(`${COPY}/`)).toBe('/Users/sam/.claude/plugins/data/kore-model-router-dk-tools')
})

test('a plugin run from its own folder keeps its logs beside it', () => {
  expect(dataDir('/Users/sam/dev/DK.Tools/kore-router')).toBe('/Users/sam/dev/DK.Tools/kore-router')
  expect(versionsDir('/Users/sam/dev/DK.Tools/kore-router')).toBeUndefined()
})

test("an installed copy's earlier versions sit beside it", () => {
  expect(versionsDir(COPY)).toEqual({ dir: '/Users/sam/.claude/plugins/cache/dk-tools/kore-model-router', current: '0.4.0' })
})

test('a Windows install path finds its data folder too', () => {
  expect(dataDir('C:\\Users\\sam\\.claude\\plugins\\cache\\dk-tools\\kore-model-router\\0.4.0')).toBe(
    'C:\\Users\\sam\\.claude/plugins/data/kore-model-router-dk-tools',
  )
})

const SAM = { name: 'kore-model-router', claudeDir: '/Users/sam/.claude' }

test("an own routes.json is in Claude Code's data folder for the plugin, installed or run from its folder", () => {
  expect(ownRoutes(COPY, SAM)).toBe('/Users/sam/.claude/plugins/data/kore-model-router-dk-tools/routes.json')
  expect(ownRoutes('/Users/sam/dev/DK.Tools/kore-router', { ...SAM, marketplace: 'dk-tools' })).toBe(
    '/Users/sam/.claude/plugins/data/kore-model-router-dk-tools/routes.json',
  )
})

test('a plugin run with --plugin-dir, in no marketplace, is inline', () => {
  expect(ownRoutes('/Users/sam/dev/kore-router', SAM)).toBe('/Users/sam/.claude/plugins/data/kore-model-router-inline/routes.json')
})

const ROUTES = {
  classifier: 'jev',
  minConfidence: 0.5,
  timeoutMs: 2000,
  rules: [],
  tasks: [
    { name: 'answer', model: 'haiku', effort: 'low', when: 'quick' },
    { name: 'design', model: 'fable', effort: 'high', when: 'deciding how' },
  ],
  models: [
    { name: 'haiku', id: 'claude-haiku-5-5' },
    { name: 'opus', id: 'claude-opus-5-5' },
    { name: 'fable', id: 'claude-fable-5-2', maxEffort: 'high', escalateFrom: 'xhigh' },
  ],
  efforts: [
    { name: 'low', when: 'immediate' },
    { name: 'high', when: 'trade-offs' },
    { name: 'xhigh', when: 'hard' },
  ],
} as Routes

test('roles, a subagent ceiling and a top effort the routes.json lists are accepted', () => {
  const roles = { worker: { model: 'opus', effort: 'max', ceiling: 'opus', origins: ['coordinator'], match: '^router: worker\\b' } } as Routes['roles']
  expect(() => check({ ...ROUTES, roles, subagents: { ceiling: 'opus' } })).not.toThrow()
})

test('a role naming a model, ceiling or effort routes.json does not list is refused', () => {
  expect(() => check({ ...ROUTES, roles: { worker: { model: 'gpt', effort: 'high' } } } as Routes)).toThrow('role worker names an unknown model: gpt')
  expect(() => check({ ...ROUTES, roles: { worker: { model: 'opus', effort: 'high', ceiling: 'gpt' } } } as Routes)).toThrow('unknown ceiling: gpt')
  expect(() => check({ ...ROUTES, roles: { worker: { model: 'opus', effort: 'huge' } } } as unknown as Routes)).toThrow('unknown effort: huge')
})

test('a role whose match is not a regular expression is refused', () => {
  expect(() => check({ ...ROUTES, roles: { worker: { model: 'opus', effort: 'high', match: '(' } } } as Routes)).toThrow('not a regular expression')
})

test('a model whose minConfidence is outside 0 to 1 is refused', () => {
  const models = [...ROUTES.models.slice(0, 3), { name: 'fable', id: 'claude-fable-5-2', minConfidence: 1.5 }] as Routes['models']
  expect(() => check({ ...ROUTES, models })).toThrow('model fable has a minConfidence outside 0 to 1: 1.5')
})

test('a subagent ceiling, maxEffort or escalateFrom routes.json does not know is refused', () => {
  expect(() => check({ ...ROUTES, subagents: { ceiling: 'gpt' } })).toThrow('subagents.ceiling names an unknown model: gpt')
  const models = [...ROUTES.models.slice(0, 2), { name: 'fable', id: 'claude-fable-5-2', maxEffort: 'huge' }] as Routes['models']
  expect(() => check({ ...ROUTES, models })).toThrow('model fable has an unknown maxEffort: huge')
})
