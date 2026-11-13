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

let seen: Seen | undefined

// The plugin's own status line under the prompt, on every surface. It is not
// drawn into the desktop footer's mode labels: that slot is one short label,
// and kore-model-router's line already fills it.
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
  // A failed check keeps the last answer for the same folder.
  if (text === undefined && seen?.cwd === cwd) text = seen.text
  seen = { cwd, at: Date.now(), text }
  $.ui.status(text)
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
}
