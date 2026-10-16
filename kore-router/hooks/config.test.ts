import { expect, test } from 'claude-code/testing'
import { dataDir, ownRoutes, versionsDir } from './config'

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
