import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = os.homedir()
export const dataDir = path.join(process.env.XDG_DATA_HOME || path.join(home, '.local/share'), 'netlify-usage')
export const configFile = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'netlify-usage/config.json')
const historyFile = path.join(dataDir, 'history.jsonl')

export function readHistory() {
  if (!fs.existsSync(historyFile)) return []
  return fs
    .readFileSync(historyFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

export function append(entry) {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.appendFileSync(historyFile, JSON.stringify(entry) + '\n')
}

// Per-site notes the API can't know: a reason a site must stay, or must go.
export function readConfig() {
  if (!fs.existsSync(configFile)) return { sites: {} }
  const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  return { sites: {}, ...cfg }
}

export { historyFile }
