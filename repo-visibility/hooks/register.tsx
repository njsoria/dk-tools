import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

type Seen = { cwd: string; at: number; text: string | undefined }

const MAX_AGE_MS = 10 * 60 * 1000

/** One line for `gh repo view --json nameWithOwner,visibility`'s output. */
export function describe(stdout: string): string | undefined {
  try {
    const { nameWithOwner, visibility } = JSON.parse(stdout)
    if (typeof visibility !== 'string') return undefined
    const name = typeof nameWithOwner === 'string' ? ` · ${nameWithOwner}` : ''
    switch (visibility.toUpperCase()) {
      case 'PUBLIC':
        return `🌐 public${name}`
      case 'PRIVATE':
        return `🔒 private${name}`
      case 'INTERNAL':
        return `🏢 internal${name}`
    }
  } catch {}
  return undefined
}

/** The line without the repo's name: `🔒 private`. */
export function short(text: string): string {
  return text.split(' · ')[0] ?? text
}

// Drawn by the ui.render hooks below; a write redraws them.
const line = atom({ plugin: 'repoVis', key: 'line' } as const, null)

let seen: Seen | undefined

async function refresh($: EngineInterface) {
  const cwd = await $.session.cwd()
  if (seen && seen.cwd === cwd && Date.now() - seen.at < MAX_AGE_MS) return
  let text: string | undefined
  try {
    const run = await $.process.run(
      ['gh', 'repo', 'view', '--json', 'nameWithOwner,visibility'],
      { cwd, timeoutMs: 10_000 },
    )
    text = run.exitCode === 0 ? describe(run.stdout) : undefined
  } catch {
    text = undefined
  }
  seen = { cwd, at: Date.now(), text }
  await update($, line, () => text ?? null)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await refresh($)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await refresh($)
    return next(e)
  })

  // The terminal's line under the prompt: the repo first, the engine's own
  // hints after it.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const text = await read($, line)
    if (text === null) return next(e)
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box columnGap={2}>
        <Text dimColor>{text}</Text>
        {await next(e)}
      </Box>
    )
  })

  // The desktop app never asks for the hint line; under its input bar it draws
  // the session's mode labels, so there the repo sits beside them. That row is
  // narrow, so it shows the visibility alone. Plain text, not a Button: a
  // second Button in that row hid kore-model-router's.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.surface === 'terminal') return next(e)
    const text = await read($, line)
    if (text === null) return next(e)
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box columnGap={1}>
        <Text dimColor>{short(text)}</Text>
        {await next(e)}
      </Box>
    )
  })
}
