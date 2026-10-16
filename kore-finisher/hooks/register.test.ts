import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// A fixed moment for the mock clock to start at.
const NOW = Date.parse('2026-10-11T12:00:00.000Z')
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()

// What `gh search prs` reports: your open PRs. `null` makes `gh` fail.
type Open = { repository: { nameWithOwner: string }; number: number; title: string; isDraft: boolean; updatedAt: string; url: string }[] | null

const open = (repo: string, number: number, title: string, minutes: number, isDraft = false) => ({
  repository: { nameWithOwner: repo },
  number,
  title,
  isDraft,
  updatedAt: minutesAgo(minutes),
  url: `https://github.com/${repo}/pull/${number}`,
})

// The world beneath the plugin: its files, a quiet desktop session, the PRs `gh`
// knows about, and what each tool call prints.
function world(on: On, files: Record<string, string> = {}, pulls: Open = [], session = { id: 'this-session', surface: 'desktop' as const, cwd: '/dev/DK.Tools' }) {
  const find = (path: string) => Object.keys(files).find(name => path.endsWith(name))
  mock.clock(on, { now: NOW })
  on('fs.read', ($, e) => {
    const name = find(e.path)
    return name === undefined ? { deny: 'no such file' } : { value: files[name]! }
  })
  on('fs.list', ($, e) => ({
    value: Object.keys(files)
      .filter(name => name.startsWith('logs/') && e.path.endsWith('logs'))
      .map(name => ({ name: name.slice('logs/'.length), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.write', ($, e) => {
    files[find(e.path) ?? e.path.slice(e.path.lastIndexOf('logs/'))] = e.text
    return { value: undefined }
  })
  on('session.id', () => ({ value: session.id }))
  on('session.surface', () => ({ value: session.surface }))
  on('session.cwd', () => ({ value: session.cwd }))
  on('process.run', () =>
    pulls === null
      ? { value: { exitCode: 1, stdout: '', stderr: 'gh: not signed in' } }
      : { value: { exitCode: 0, stdout: JSON.stringify(pulls), stderr: '' } },
  )
  // What the tool prints: a `gh pr create` names the new PR; anything else prints nothing.
  on('tool.call', ($, e) => ({
    result: { stdout: String((e as { command?: string }).command ?? '').includes('pr create') ? 'https://github.com/acme/web/pull/42\n' : '', stderr: '' },
  }))
  on('classic.Notification', () => ({}))
  on('classic.Stop', () => ({}))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
  })
  return files
}

const run = ($: Engine) =>
  $.command.run({ command: 'outstanding', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

const wait = (state: string, extra: object = {}) =>
  JSON.stringify({ sessionId: 'x', surface: 'terminal', cwd: '/dev/other', state, kind: 'permission', text: 'May I run it?', ...extra })

const pulls = (sessionId: string, surface: string | null, cwd: string, prs: Record<string, { firstSeen: string; lastSeen: string }>) =>
  JSON.stringify({
    sessionId,
    surface,
    cwd,
    prs: Object.fromEntries(Object.entries(prs).map(([url, times]) => [url, { url, ...times }])),
  })

test('a permission prompt is listed until the person answers', async ($, on) => {
  const files = world(on)
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
  expect(JSON.parse(files['logs/this-session.waiting.json']!)).toMatchObject({ state: 'waiting', kind: 'permission', surface: 'desktop' })
  const { text } = await run($)
  expect(text).toContain('Outstanding: 1')
  expect(text).toContain('DK.Tools')
  expect(text).toContain('needs permission')
  await $.prompt.submit({ text: 'yes, go ahead', wait: false, origin: { kind: 'composer' } })
  expect((await run($)).text).toBe('Nothing outstanding.')
})

test('the next model request clears a wait', async ($, on) => {
  const files = world(on)
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
  for await (const _ of $.turn.step({ turnId: 't', index: 1, model: 'claude-opus-5-5', effort: 'high', messageCount: 4 })) {
    // the test's model answers nothing
  }
  expect(JSON.parse(files['logs/this-session.waiting.json']!).state).toBe('clear')
})

test('a turn that ends on a question waits; one that ends on a statement does not', async ($, on) => {
  const files = world(on)
  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Done.\n\nShould I also update the README?' })
  expect(JSON.parse(files['logs/this-session.waiting.json']!)).toMatchObject({ state: 'waiting', kind: 'question', text: 'Should I also update the README?' })
  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'All done.' })
  expect(JSON.parse(files['logs/this-session.waiting.json']!).state).toBe('clear')
})

test('a session with nothing outstanding writes no file', async ($, on) => {
  const files = world(on)
  await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'All done.' })
  await $.prompt.submit({ text: 'next thing', wait: false, origin: { kind: 'composer' } })
  expect(Object.keys(files)).toEqual([])
})

test('a gh pr create records the PR the call printed', async ($, on) => {
  const files = world(on)
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --title "Add login" --body ""' } as never)
  expect(Object.keys(files)).toEqual(['logs/this-session.prs.json'])
  expect(JSON.parse(files['logs/this-session.prs.json']!)).toMatchObject({ surface: 'desktop', cwd: '/dev/DK.Tools' })
  expect(Object.keys(JSON.parse(files['logs/this-session.prs.json']!).prs)).toEqual(['https://github.com/acme/web/pull/42'])
})

test('gh pr list records nothing: it only reads many PRs', async ($, on) => {
  const files = world(on)
  await $.tool.call({ tool: 'Bash', command: 'gh pr list' } as never)
  expect(files).toEqual({})
})

test('a desktop PR binding records the PR the call named', async ($, on) => {
  const files = world(on)
  await $.tool.call({ tool: 'mcp__ccd_pr__bind_pr', url: 'https://github.com/acme/api/pull/7' } as never)
  expect(Object.keys(JSON.parse(files['logs/this-session.prs.json']!).prs)).toEqual(['https://github.com/acme/api/pull/7'])
})

test('the list keeps the desktop app and the terminal apart, with waits and PRs in each', async ($, on) => {
  world(
    on,
    {
      'logs/app.waiting.json': wait('waiting', { sessionId: 'app', surface: 'desktop', cwd: '/dev/web', kind: 'question', text: 'Which database?', since: minutesAgo(5), updated: minutesAgo(5) }),
      'logs/cli.waiting.json': wait('waiting', { sessionId: 'cli', cwd: '/dev/api', since: minutesAgo(90), updated: minutesAgo(90) }),
      'logs/gone.waiting.json': wait('waiting', { sessionId: 'gone', cwd: '/dev/old', since: minutesAgo(60 * 20), updated: minutesAgo(60 * 20) }),
      'logs/done.waiting.json': wait('ended', { sessionId: 'done', cwd: '/dev/done', updated: minutesAgo(1) }),
      'logs/app.prs.json': pulls('app', 'desktop', '/dev/web', { 'https://github.com/acme/web/pull/3': { firstSeen: minutesAgo(200), lastSeen: minutesAgo(10) } }),
      'logs/cli.prs.json': pulls('cli', 'terminal', '/dev/api', { 'https://github.com/acme/api/pull/9': { firstSeen: minutesAgo(30), lastSeen: minutesAgo(30) } }),
    },
    [open('acme/web', 3, 'Add login', 200), open('acme/api', 9, 'Rate limits', 30, true)],
  )
  const { text } = await run($)
  expect(text).toContain('Outstanding: 4')
  // Each group lists its items oldest first: the PR from 200 minutes ago, then the question from 5.
  expect(text.indexOf('Desktop app (2)')).toBeLessThan(text.indexOf('acme/web #3'))
  expect(text.indexOf('acme/web #3')).toBeLessThan(text.indexOf('Which database?'))
  expect(text.indexOf('Which database?')).toBeLessThan(text.indexOf('Terminal and editors (2)'))
  expect(text.indexOf('Terminal and editors (2)')).toBeLessThan(text.indexOf('May I run it?'))
  expect(text.indexOf('May I run it?')).toBeLessThan(text.indexOf('acme/api #9'))
  expect(text).toContain('draft')
  expect(text).toContain('ready for review')
  expect(text).toContain('Rate limits')
  expect(text).toContain('1h')
  expect(text).not.toMatch(/old|done|Not from a recorded session/)
})

test('an open PR no session recorded is listed apart, never dropped', async ($, on) => {
  world(on, {}, [open('acme/tools', 12, 'Clean up logs', 45)])
  const { text } = await run($)
  expect(text).toContain('Not from a recorded session (1)')
  expect(text).toContain('acme/tools #12')
  expect(text).toContain('Desktop app: nothing outstanding')
})

test('this session marks the PR it recorded', async ($, on) => {
  world(on, { 'logs/this-session.prs.json': pulls('this-session', 'desktop', '/dev/DK.Tools', { 'https://github.com/acme/web/pull/5': { firstSeen: minutesAgo(1), lastSeen: minutesAgo(1) } }) }, [open('acme/web', 5, 'Fix it', 1)])
  const { text } = await run($)
  expect(text).toContain('acme/web #5 · ready for review')
  expect(text).toContain('this session')
})

test('with no open PR and nothing waiting, nothing is outstanding', async ($, on) => {
  world(on, {}, [])
  expect((await run($)).text).toBe('Nothing outstanding.')
})

test('a failed gh says so and still lists what is waiting', async ($, on) => {
  world(on, { 'logs/cli.waiting.json': wait('waiting', { since: minutesAgo(0), updated: minutesAgo(0) }) }, null)
  const { text } = await run($)
  expect(text).toContain('Terminal and editors (1)')
  expect(text).toContain('GitHub could not be reached, so pull requests are not listed.')
})

test('a list with nothing in one group still shows both', async ($, on) => {
  world(on, { 'logs/cli.waiting.json': wait('waiting', { since: minutesAgo(0), updated: minutesAgo(0) }) })
  const { text } = await run($)
  expect(text).toContain('Desktop app: nothing outstanding')
  expect(text).toContain('Terminal and editors (1)')
})
