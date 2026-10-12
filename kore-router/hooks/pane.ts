// What the router's pane says about each decision: a one-line summary, and
// every field behind it for when a row is opened. register.tsx draws it.

import type { Entry } from './ledger'

export const LIME = '#AADD00'

export const clock = (at: string) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

// "claude-opus-5-5 · medium" as its two parts, the model by its family name.
const parts = (ran = '') => {
  const [model = '', effort = ''] = ran.split(' · ')
  return { model: model.replace(/^claude-|-[\d-]+.*$/g, ''), effort }
}

// The row's summary: when, what it ran on, and whose it was.
export function summary(row: Entry) {
  const { model, effort } = parts(row.ran)
  const route = row.failed === undefined ? `${model} · ${effort}` : 'no new route'
  const marks = [row.agent === undefined ? '' : `  ${row.agent}`, row.held ? '  held' : '', row.note === undefined ? '' : '  *'].join('')
  return `${clock(row.at)}  ${route}${marks}`
}

const ms = (n: number | undefined) => (n === undefined ? undefined : `${n} ms`)

// Every field the log holds for the row, in reading order; empty ones left out.
export function details(row: Entry): [string, string][] {
  const fields: [string, string | undefined][] = [
    ['Prompt', row.prompt],
    ['Failed', row.failed],
    ['Asked for', row.wanted],
    ['Ran on', row.ran],
    ['Decided by', row.via],
    ['Changed because', row.note],
    ['Subagent', row.agent],
    ['Session had', row.session === undefined ? undefined : `${row.session}${row.sessionEffort === undefined ? '' : ` · ${row.sessionEffort}`}`],
    ['Messages', row.messages === undefined ? undefined : String(row.messages)],
    ['Classifier', ms(row.classifyMs)],
    ['Routing took', ms(row.routeMs)],
    ['At', row.at],
  ]
  return fields.filter((field): field is [string, string] => field[1] !== undefined && field[1] !== '')
}
