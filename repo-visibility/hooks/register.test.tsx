import { expect, test } from 'claude-code/testing'

const GH = JSON.stringify({ nameWithOwner: 'njsoria/dk-tools', visibility: 'PUBLIC' })

test('the status line names the repo and its visibility', async ($, on) => {
  on('session.cwd', () => ({ value: '/repo' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: GH, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  const said: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    said.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  expect(said).toEqual(['🌐 public · njsoria/dk-tools'])
})

test('outside a GitHub repo it shows nothing', async ($, on) => {
  on('session.cwd', () => ({ value: '/tmp' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'no repo', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  const said: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    said.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect(said).toEqual([undefined])
})
