// Checks the pushback guard against the corrections and the near-misses in
// cases.json, with the same test the plugin runs on a prompt. It is offline and
// needs no key.
//
//   npx -y tsx@4.19.2 eval/pushback.ts [--routes routes.json] [--cases eval/cases.json]

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { clean } from '../hooks/classify'
import { type Routes, check } from '../hooks/config'

const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]!
}

const routes = check(JSON.parse(readFileSync(resolve(arg('routes', join(__dirname, '..', 'routes.json'))), 'utf8')) as Routes)
const { escalate, steady } = (JSON.parse(readFileSync(resolve(arg('cases', join(__dirname, 'cases.json'))), 'utf8')) as {
  pushback: { escalate: string[]; steady: string[] }
}).pushback

const pattern = routes.guards?.pushback
if (pattern === undefined) {
  console.error('routes.json has no guards.pushback.')
  process.exit(1)
}
const matches = (prompt: string) => new RegExp(pattern, 'i').test(clean(prompt))

// A big paste goes through the pattern whole, so it must stay linear.
const pastes = ['Fix this.\n' + '\n'.repeat(200_000), 'a' + '.'.repeat(200_000), ',,,,,,,\n'.repeat(20_000), 'a. ' + ' '.repeat(200_000)]
const slow = pastes.filter(paste => {
  const started = performance.now()
  matches(paste)
  return performance.now() - started > 250
})

const misses = [
  ...slow.map(paste => `SLOW       ${paste.length} characters of ${JSON.stringify(paste.slice(0, 12))}...`),
  ...escalate.filter(prompt => !matches(prompt)).map(prompt => `MISSED     "${prompt}"`),
  ...steady.filter(matches).map(prompt => `ESCALATED  "${prompt}"`),
]
console.log(`${escalate.length} corrections, ${steady.length} ordinary prompts: ${misses.length === 0 ? 'all right' : `${misses.length} wrong`}`)
for (const line of misses) console.log(`  ${line}`)
process.exit(misses.length === 0 ? 0 : 1)
