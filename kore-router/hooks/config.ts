// routes.json, typed, and the small lookups every part of the router shares.

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type Rates = { input: number; output: number; cacheRead: number; cacheWrite: number }

// Dollars per million tokens, and the dearer rates some models charge once a
// request carries more than `above` tokens.
export type Price = Rates & { longContext?: Rates & { above: number } }

// A kind of job, and the least model and effort it is ever run on.
export type Task = { name: string; model: string; effort: Effort; when: string }

export type Model = {
  name: string
  id: string
  // The most context, in tokens, this model is trusted to work in. Past it the
  // router keeps a stronger model, whatever the job.
  maxContext?: number
}

// A rule decides the route outright, or, with `atLeast`, only raises what the
// classifier answers to its task (or model and effort) when it answers less.
export type Rule = { match: string; why: string; atLeast?: boolean } & ({ task: string } | { model: string; effort: Effort })

export type Routes = {
  classifier: 'jev' | 'haiku'
  minConfidence: number
  timeoutMs: number
  openPane?: boolean
  baseline?: { model: string; effort: Effort }
  pricing?: Record<string, Price>
  switching?: {
    // A turn's likely size before its own figures exist: requests, and output tokens.
    expectedSteps?: number
    expectedOutput?: number
    // How long a model's cache outlives its last request, in minutes.
    cacheTtlMinutes?: number
    // A step down must save this many times what the switch costs.
    margin?: number
    // Without prices, the longest conversation the router steps down in.
    fallbackMessages?: number
  }
  guards?: {
    // A prompt this matches is a person saying the last turn fell short.
    pushback?: string
    // A prompt this matches whole ("yes, go ahead") continues the job under
    // way on the route in force, with no classifier call.
    followUp?: string
    // A prompt of this many words or fewer, with no question mark, is too thin
    // to classify ("router pane"): it keeps the route in force. Default 2; 0 turns it off.
    shortWords?: number
    // How many of the person's turns an escalation holds for.
    holdTurns?: number
    // Tool errors in one turn, below the top model, before it moves up a tier.
    toolErrors?: number
  }
  subagents?: {
    // Classify a subagent's task when its type isn't listed below.
    classify?: boolean
    // Agent type to task, settled without a classifier.
    types?: Record<string, string>
  }
  rules: Rule[]
  tasks: Task[]
  models: Model[]
  efforts: { name: Effort; when: string }[]
}

// A mistake in routes.json is found when it is read, not halfway through a turn.
export function check(routes: Routes) {
  const models = new Set(routes.models.map(model => model.name))
  const tasks = new Set(routes.tasks.map(task => task.name))
  const efforts = new Set<string>(routes.efforts.map(effort => effort.name))
  for (const task of routes.tasks) {
    if (!models.has(task.model)) throw new Error(`task ${task.name} names an unknown model: ${task.model}`)
    if (!efforts.has(task.effort)) throw new Error(`task ${task.name} names an unknown effort: ${task.effort}`)
  }
  for (const rule of routes.rules) {
    if ('task' in rule ? !tasks.has(rule.task) : !models.has(rule.model)) {
      throw new Error(`the rule for /${rule.match}/ names an unknown ${'task' in rule ? `task: ${rule.task}` : `model: ${rule.model}`}`)
    }
  }
  for (const [type, task] of Object.entries(routes.subagents?.types ?? {})) {
    if (!tasks.has(task)) throw new Error(`subagent ${type} names an unknown task: ${task}`)
  }
  return routes
}

// Efforts past the listed ones (`max`) rank above them all.
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export const effortRank = (effort: string | number | undefined) =>
  typeof effort === 'string' ? EFFORTS.indexOf(effort as Effort) : -1

export const stronger = (a: Effort, b: Effort) => (effortRank(a) >= effortRank(b) ? a : b)

export const nextEffort = (effort: Effort) => EFFORTS[Math.min(effortRank(effort) + 1, EFFORTS.length - 1)]!

// A model's place, weakest first. A model routes.json doesn't list ranks above
// the ones it does: the router never assumes an unknown model is weaker.
export const tier = (routes: Routes, id: string) => {
  const at = routes.models.findIndex(model => id === model.id || id === model.name || id.includes(model.name))
  return at === -1 ? routes.models.length : at
}

export const model = (routes: Routes, name: string) => {
  const found = routes.models.find(model => model.name === name || model.id === name)
  if (found === undefined) throw new Error(`no model called ${name}`)
  return found
}

export const task = (routes: Routes, name: string) => {
  const found = routes.tasks.find(task => task.name === name)
  if (found === undefined) throw new Error(`no task called ${name}`)
  return found
}

// The price of a model by its id, a variant such as `[1m]` priced as its base.
export const price = (routes: Routes, id: string) => routes.pricing?.[id] ?? routes.pricing?.[id.replace(/\[.*\]$/, '')]

// A plugin installed from a repository or the directory runs a copy,
// plugins/cache/<marketplace>/<plugin>/<version>, which the next version
// replaces. What must outlive an update, the logs and a person's own
// routes.json, goes to the folder Claude Code keeps for the plugin's data,
// plugins/data/<plugin>-<marketplace>. A plugin run from its own folder (a
// folder marketplace, --plugin-dir) keeps them beside it.
const INSTALLED = /^(.*)[\\/]plugins[\\/]cache[\\/]([^\\/]+)[\\/]([^\\/]+)[\\/]([^\\/]+)[\\/]?$/

export function dataDir(root: string) {
  const at = INSTALLED.exec(root)
  return at === null ? root : `${at[1]}/plugins/data/${`${at[3]}-${at[2]}`.replace(/[^\w-]/g, '-')}`
}

// The folder holding every installed version, whose logs/ earlier versions wrote.
export function versionsDir(root: string) {
  const at = INSTALLED.exec(root)
  return at === null ? undefined : { dir: `${at[1]}/plugins/cache/${at[2]}/${at[3]}`, current: at[4]! }
}
