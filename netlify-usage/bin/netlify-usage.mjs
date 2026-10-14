#!/usr/bin/env node
import fs from 'node:fs'
import { parseArgs } from 'node:util'
import { collect } from '../lib/netlify.mjs'
import { analyze, usd, n } from '../lib/model.mjs'
import { render } from '../lib/report.mjs'
import { append, readHistory, readConfig, historyFile, configFile } from '../lib/store.mjs'

const pricing = JSON.parse(fs.readFileSync(new URL('../pricing.json', import.meta.url), 'utf8'))

const HELP = `netlify-usage: track Netlify credits, find the pain spots, see which sites to move off

  netlify-usage [report]      fetch usage, save a snapshot, print the report
  netlify-usage brief <n>     print pain spot n's agent brief, from the last snapshot
  netlify-usage history       one line per day a snapshot was taken

  --team <slug>   Netlify team (default: your default team)
  --json          print the snapshot and analysis as JSON
  --no-save       don't add this run to the history

History: ${historyFile}
Per-site notes: ${configFile}`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    team: { type: 'string' },
    json: { type: 'boolean' },
    'no-save': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
})

const [command = 'report', arg] = positionals
const snapshots = () => readHistory().filter((h) => h.type === 'snapshot' && (!values.team || h.team.slug === values.team))
const run = (snap) => analyze(snap, { config: readConfig(), pricing, now: Date.parse(snap.at) })

async function main() {
  if (values.help || command === 'help') return console.log(HELP)

  if (command === 'history') {
    const byDay = new Map()
    for (const h of snapshots()) byDay.set(h.at.slice(0, 10), h)
    for (const [d, h] of byDay) {
      const a = run(h)
      console.log(`${d}  ${n(a.perDay)} credits a day  balance ${n(a.available)}  month at this pace ${usd(a.steady.total)}  pain spots ${a.painSpots.length}`)
    }
    return
  }

  if (command === 'brief') {
    let snap = snapshots().at(-1)
    if (!snap) snap = await collect({ team: values.team })
    const spots = run(snap).painSpots
    const spot = spots[Number(arg) - 1]
    if (!spot) throw new Error(`No pain spot ${arg}. The last snapshot has ${spots.length}.`)
    if (!spot.brief) throw new Error(`Pain spot ${arg} has no brief: ${spot.title}.`)
    return console.log(spot.brief)
  }

  if (command !== 'report') throw new Error(`Unknown command "${command}". Try --help.`)
  const snap = await collect({ team: values.team })
  if (!values['no-save']) append({ type: 'snapshot', ...snap })
  const a = analyze(snap, { config: readConfig(), pricing })
  if (values.json) return console.log(JSON.stringify({ snapshot: snap, analysis: a }, null, 2))
  console.log(render(snap, a))
  console.log(`\nHosting prices checked ${pricing.checked}, in pricing.json.`)
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
