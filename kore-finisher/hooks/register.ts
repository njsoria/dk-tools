// Kore Finisher: what you still have outstanding across your Claude sessions.
//
// Two kinds of outstanding work, both kept per session in logs/:
//   - a session waiting on you: a permission prompt, an input request or a
//     question it ended on (`waiting.json`, one file overwritten as it changes);
//   - a pull request the session created or worked on (`prs.json`, one entry
//     per PR URL).
// `/outstanding` lists both, split into the desktop app's sessions and the
// terminal's and editors'. The pull requests listed are every open one GitHub
// says you authored (`gh search prs`), so none is missed and a merged or closed
// one drops off; what a session recorded says which group a PR belongs in, and
// one no session recorded is listed apart.
//
// Later this is where a sanity check on what blocks what, and in what order to
// finish, will live.

import type { EngineInterface, Register } from 'claude-code'

type Surface = string | null

type Wait = {
  sessionId: string
  surface: Surface
  cwd: string
  state: 'waiting' | 'clear' | 'ended'
  kind?: 'permission' | 'question' | 'input'
  text?: string
  since?: string
  updated: string
}

type Pull = { url: string; firstSeen: string; lastSeen: string }
type Pulls = { sessionId: string; surface: Surface; cwd: string; prs: Record<string, Pull> }

type Open = { repository: { nameWithOwner: string }; number: number; title: string; isDraft: boolean; updatedAt: string; url: string }

const LOGS = 'logs'
const WAITING = 'waiting.json'
const PULLS = 'prs.json'
// A session that was killed never says it ended, so a wait this old is dropped.
// A pull request isn't dropped by age: GitHub says whether it is still open.
const STALE_AFTER = 12 * 3_600_000
// How many of your open pull requests one listing asks GitHub for.
const MAX_OPEN = 50
const NEEDS = { permission: 'needs permission', question: 'asked a question', input: 'needs input' }
// A prompt answers a session when a person sent it, not when a notification did.
const FROM_A_PERSON = new Set(['composer', 'bridge', 'sdk'])
// `gh pr create`, `view`, `checkout`, `merge` and the rest touch a PR; `list` and `status` only read many.
const GH_PR = /\bgh\s+pr\s+(?!list\b|status\b)\w+/
// Desktop-app calls that bind a PR to the session.
const DESKTOP_PR = /^mcp__ccd_pr__(bind_pr|set_monitor|set_auto_merge)$/
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g

// A long text says most about itself at its start and its end.
const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max / 2)}\n[...]\n${text.slice(-max / 2)}`

const logFile = async ($: EngineInterface, kind: string) => `${$.plugin.root}/${LOGS}/${await $.session.id()}.${kind}`

const parseEach = <T>(texts: string[]) =>
  texts.flatMap(text => {
    try {
      return [JSON.parse(text) as T]
    } catch {
      return []
    }
  })

// One write at a time, so two changes from this session can't cross.
let writing: Promise<unknown> = Promise.resolve()
const queue = (work: () => Promise<void>) => {
  writing = writing.then(work).catch(() => undefined)
  return writing
}

// Unknown after a reload, so the first clear looks at the file.
let mayBeWaiting = true

function setWait($: EngineInterface, change: Pick<Wait, 'state' | 'kind' | 'text'>) {
  return queue(async () => {
    const file = await logFile($, WAITING)
    const held = JSON.parse(await $.fs.read(file).catch(() => 'null')) as Wait | null
    const isHeld = held?.state === 'waiting'
    if (change.state !== 'waiting') {
      mayBeWaiting = false
      if (!isHeld) return
    }
    const now = new Date(await $.clock.now()).toISOString()
    const wait: Wait = {
      sessionId: await $.session.id(),
      surface: await $.session.surface(),
      cwd: await $.session.cwd(),
      ...change,
      since: change.state === 'waiting' ? (isHeld ? held.since : now) : undefined,
      updated: now,
    }
    if (change.state === 'waiting') mayBeWaiting = true
    await $.fs.write(file, JSON.stringify(wait))
  })
}

const stopWaiting = ($: EngineInterface) => (mayBeWaiting ? setWait($, { state: 'clear' }) : undefined)

function notePulls($: EngineInterface, urls: string[]) {
  if (urls.length === 0) return undefined
  return queue(async () => {
    const file = await logFile($, PULLS)
    const held = JSON.parse(await $.fs.read(file).catch(() => 'null')) as Pulls | null
    const now = new Date(await $.clock.now()).toISOString()
    const prs: Record<string, Pull> = { ...held?.prs }
    for (const url of urls) prs[url] = { url, firstSeen: prs[url]?.firstSeen ?? now, lastSeen: now }
    const pulls: Pulls = { sessionId: await $.session.id(), surface: await $.session.surface(), cwd: await $.session.cwd(), prs }
    await $.fs.write(file, JSON.stringify(pulls))
  })
}

// A question put in words ends the turn like any answer; this tells them apart.
const ASKS = /\?[\s"'’”)\]*_`]*$/
const lastParagraph = (text: string) => text.trim().split(/\n\s*\n/).pop()!.trim()

// A session started by the desktop app, or by a host that draws nothing, has
// no terminal; the rest run in a terminal or an editor.
const isApp = (surface: Surface) => surface === 'desktop' || surface === null

const ago = (ms: number) => (ms < 60_000 ? 'now' : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 3_600_000)}h`)

const project = (cwd: string) => cwd.split('/').filter(Boolean).pop() ?? cwd

// Every open PR you authored, from GitHub; `undefined` when `gh` can't say (not
// installed, not signed in, offline).
async function openPulls($: EngineInterface) {
  try {
    const ran = await $.process.run(
      ['gh', 'search', 'prs', '--author', '@me', '--state', 'open', '--limit', String(MAX_OPEN), '--json', 'repository,number,title,isDraft,updatedAt,url'],
      { timeoutMs: 20_000 },
    )
    return ran.exitCode === 0 ? (JSON.parse(ran.stdout) as Open[]) : undefined
  } catch {
    return undefined
  }
}

// `surface` is undefined for a PR no session recorded.
type Row = { surface: Surface | undefined; at: string; lines: string[] }

async function outstanding($: EngineInterface) {
  const dir = `${$.plugin.root}/${LOGS}`
  const names = (await $.fs.list(dir).catch(() => [])).map(entry => entry.name)
  const read = (suffix: string) =>
    Promise.all(names.filter(name => name.endsWith(`.${suffix}`)).map(name => $.fs.read(`${dir}/${name}`).catch(() => '')))
  const now = await $.clock.now()
  const mine = await $.session.id()
  // The desktop app already links "owner/repo #N", so a URL line there is a second link to the same PR.
  const linksRefs = (await $.session.surfaces()).includes('desktop')

  const waits = parseEach<Wait>(await read(WAITING)).filter(wait => wait.state === 'waiting' && now - Date.parse(wait.updated) < STALE_AFTER)

  // The session that last touched each PR, from what the sessions recorded.
  const touched = new Map<string, Pull & { sessionId: string; surface: Surface }>()
  for (const pulls of parseEach<Pulls>(await read(PULLS))) {
    for (const pr of Object.values(pulls.prs)) {
      const seen = touched.get(pr.url)
      if (seen === undefined || pr.lastSeen > seen.lastSeen) touched.set(pr.url, { ...pr, sessionId: pulls.sessionId, surface: pulls.surface })
    }
  }
  const open = await openPulls($)

  const rows: Row[] = [
    ...waits.map(wait => {
      const head = [project(wait.cwd), ago(now - Date.parse(wait.since ?? wait.updated)), NEEDS[wait.kind ?? 'input'], ...(wait.sessionId === mine ? ['this session'] : [])]
      return {
        surface: wait.surface,
        at: wait.since ?? wait.updated,
        lines: [`  \u25cf ${head.join(' \u00b7 ')}`, ...(wait.text ? [`      ${wait.text}`] : [])],
      }
    }),
    ...(open ?? []).map(pr => {
      const from = touched.get(pr.url)
      const head = [`${pr.repository.nameWithOwner} #${pr.number}`, pr.isDraft ? 'draft' : 'ready for review', `updated ${ago(now - Date.parse(pr.updatedAt))} ago`, ...(from?.sessionId === mine ? ['this session'] : [])]
      return {
        surface: from === undefined ? undefined : from.surface,
        at: pr.updatedAt,
        lines: [`  \u25cb ${head.join(' \u00b7 ')}`, `      ${clip(pr.title, 120)}`, ...(linksRefs ? [] : [`      ${pr.url}`])],
      }
    }),
  ]

  const note = open === undefined ? ['', 'GitHub could not be reached, so pull requests are not listed.'] : []
  if (rows.length === 0) return ['Nothing outstanding.', ...note].join('\n')
  const group = (title: string, of: Row[]) => {
    const sorted = [...of].sort((a, b) => a.at.localeCompare(b.at))
    return sorted.length === 0 ? [`${title}: nothing outstanding`] : [`${title} (${sorted.length})`, ...sorted.flatMap(row => row.lines)]
  }
  const apart = rows.filter(row => row.surface === undefined)
  return [
    `Outstanding: ${rows.length}`,
    '',
    ...group('Desktop app', rows.filter(row => row.surface !== undefined && isApp(row.surface))),
    '',
    ...group('Terminal and editors', rows.filter(row => row.surface !== undefined && !isApp(row.surface))),
    // Pull requests no session recorded: made before the plugin ran, or from a repo it never saw.
    ...(apart.length === 0 ? [] : ['', ...group('Not from a recorded session', apart)]),
    ...note,
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'outstanding', description: 'List what is outstanding across your Claude sessions: waiting on you, and open pull requests' })
    return next(e)
  })

  on('classic.Notification', async ($, e, next) => {
    if (e.notification_type === 'permission_prompt' || e.notification_type === 'elicitation_dialog') {
      await setWait($, {
        state: 'waiting',
        kind: e.notification_type === 'permission_prompt' ? 'permission' : 'input',
        text: clip(e.message, 160),
      })
    }
    return next(e)
  })

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    await setWait($, { state: 'waiting', kind: 'question', text: clip(e.questions[0]?.question ?? '', 160) })
    try {
      return await next(e)
    } finally {
      await stopWaiting($)
    }
  })

  // Records the PRs a session creates or works on. It only observes: the call
  // runs as the session asked, and a failure to record never reaches it.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    try {
      const tool = String(e.tool)
      const command = String((e as { command?: unknown }).command ?? '')
      if (tool === 'Bash' ? GH_PR.test(command) : DESKTOP_PR.test(tool)) {
        // A PR named by the call, or in what it printed: `gh pr create` prints the new URL.
        const seen = JSON.stringify([e, ran]).match(PR_URL) ?? []
        await notePulls($, [...new Set(seen)])
      }
    } catch {
      // Not recording a PR must not fail the call.
    }
    return ran
  })

  on('classic.Stop', async ($, e, next) => {
    const said = e.last_assistant_message?.trim() ?? ''
    const isAsking = ASKS.test(said) && !e.background_tasks?.length
    await (isAsking ? setWait($, { state: 'waiting', kind: 'question', text: clip(lastParagraph(said), 160) }) : stopWaiting($))
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (FROM_A_PERSON.has(e.origin.kind)) await stopWaiting($)
    return next(e)
  })

  // A new request means whoever was asked has answered.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) await stopWaiting($)
    return yield* next(e)
  })

  on('session.end', async ($, e, next) => {
    await setWait($, { state: 'ended' })
    return next(e)
  })

  on('command.run', { command: 'outstanding' }, async $ => {
    try {
      return { text: await outstanding($) }
    } catch (error) {
      return { text: `No list: ${(error as Error).message}` }
    }
  })
}
