// What the cheap classifiers, Jev (TypeSafe) or Haiku, are asked and how their
// answers are read. Each names the kind of job a request is (a task from
// routes.json) and how much thinking it calls for. The calls themselves are
// made in register.tsx.

import { type Effort, type Routes, type Task, effortRank, tier, model as modelNamed } from './config'

// `raises` are the yes-or-no tasks (`raiseAbove`) Jev said yes to.
export type Verdict = { task: Task; effort: Effort; via: string; raises?: Task[] }

// What the classifier reads: the request and, for a reply like "yes, go ahead",
// what came just before it.
export type State = { request: string; earlier: { from: string; text: string }[] }

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'

// A long text says most about itself at its start and its end.
export const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max / 2)}\n[...]\n${text.slice(-max / 2)}`

// The harness rides its own notes on a prompt; they say nothing of the job.
export const clean = (text: string) => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()

export function state(request: string, rows: readonly { role: string; text: string }[]): State {
  const earlier = rows
    .map(row => ({ from: row.role, text: clean(row.text) }))
    .filter(row => row.text !== '')
    .slice(-4)
    .map(row => ({ ...row, text: clip(row.text, 600) }))
  return { request: clip(clean(request), 8000), earlier }
}

// The kinds of job the classifier picks between, and the ones Jev is asked
// about on their own, yes or no.
const kinds = (routes: Routes) => routes.tasks.filter(task => task.raiseAbove === undefined)
const apart = (routes: Routes) => routes.tasks.filter(task => task.raiseAbove !== undefined)

// A task's `not` marks where it ends and the next kind begins.
const described = (task: Task) => (task.not === undefined ? task.when : { covers: task.when, not: task.not })

const JOB =
  "`request` is the newest message to an AI coding assistant and `earlier` is the conversation before it, oldest first. A short reply such as an approval or 'continue' asks for the job already under way in `earlier`."

// One request: the kind of job (a Choice), how hard to think (a Score), and a
// yes-or-no question (a Noul) for each task kept apart, all read in parallel.
// A task kept apart is a judgment of its own, such as how costly a mistake
// would be, that cuts across the kinds rather than competing with them.
export const jevBody = (routes: Routes, state: State) =>
  JSON.stringify({
    model: routes.jevModel ?? 'jev-latest',
    state,
    questions: {
      task: {
        type: 'choice',
        instructions: `${JOB} Which kind of job is the assistant being asked to do now?${
          apart(routes).length === 0 ? ' When the job touches anything the criteria call risky, choose that.' : ''
        }`,
        criteria: Object.fromEntries(kinds(routes).map(task => [task.name, described(task)])),
      },
      effort: {
        type: 'score',
        instructions:
          'How much thinking does the job that `request` asks for call for before acting? Judge a short reply such as an approval by the job under way in `earlier`.',
        criteria: routes.efforts.map(effort => effort.when),
      },
      ...Object.fromEntries(
        apart(routes).map(task => [
          `apart:${task.name}`,
          {
            type: 'noul',
            instructions: `${JOB} Does the job the assistant is being asked to do now fit the description in the criteria?`,
            criteria: { true: task.when, false: task.not ?? 'Nothing in the job fits that description.' },
          },
        ]),
      ),
    },
  })

type JevReply = {
  model?: string
  answers: {
    task: { choice: string; probabilities: Record<string, number>; confidence: number }
    effort: { score: number; confidence: number }
  } & Record<string, { noul?: number }>
}

export function readJev(routes: Routes, text: string): Verdict {
  const { model, answers } = JSON.parse(text) as JevReply
  const task = pickTask(routes, answers.task)
  if (task === undefined) throw new Error(`Jev named an unknown task: ${answers.task.choice}`)
  const asked = apart(routes).map(each => ({ task: each, yes: answers[`apart:${each.name}`]?.noul }))
  const raises = asked.filter(each => each.yes !== undefined && each.yes >= each.task.raiseAbove!).map(each => each.task)
  const said = asked.filter(each => each.yes !== undefined).map(each => `${each.task.name} ${Math.round(each.yes! * 100)}%`)
  return {
    task,
    effort: pickEffort(routes, answers.effort),
    via: [`${model ?? 'jev'}, ${task.name}, ${Math.round(answers.task.confidence * 100)}% sure`, ...said].join('; '),
    raises,
  }
}

// Torn between two tasks: take the one that runs on the more capable model,
// and of two on the same model, the one that thinks harder. Then, when the
// kinds on a stronger model share at least `upwardMass` of the probability
// between them, take the likeliest of those: a misroute down costs quality, one
// up only money, so the bar to move up is lower than the bar to win.
function pickTask(routes: Routes, answer: JevReply['answers']['task']) {
  const named = (name: string | undefined) => routes.tasks.find(task => task.name === name)
  const ranked = Object.entries(answer.probabilities)
    .sort((a, b) => b[1] - a[1])
    .map(([name, p]) => ({ task: named(name), p }))
    .filter((each): each is { task: Task; p: number } => each.task !== undefined)
  const level = (task: Task) => tier(routes, modelNamed(routes, task.model).id)
  const weight = (task: Task) => level(task) * 10 + effortRank(task.effort)
  let picked = named(answer.choice)
  const [first, second] = ranked
  if (answer.confidence < routes.minConfidence && first !== undefined) {
    picked = second !== undefined && weight(second.task) > weight(first.task) ? second.task : first.task
  }
  if (picked === undefined || routes.upwardMass === undefined) return picked
  for (let at = routes.models.length - 1; at > level(picked); at--) {
    const above = ranked.filter(each => level(each.task) >= at)
    if (above.reduce((sum, each) => sum + each.p, 0) < routes.upwardMass) continue
    // The mass reached the bar at this model, so a kind on it holds some.
    return (above.find(each => level(each.task) === at) ?? above[0]!).task
  }
  return picked
}

// The score lands between levels; when Jev is unsure, round up, not down.
function pickEffort(routes: Routes, answer: JevReply['answers']['effort']) {
  const level = answer.confidence >= routes.minConfidence ? Math.round(answer.score) : Math.ceil(answer.score)
  return routes.efforts[Math.max(0, Math.min(level, routes.efforts.length - 1))]!.name
}

export const haikuSystem = (routes: Routes) => {
  const guide = (list: { name: string; when: string; not?: string }[]) =>
    list.map(one => `- ${one.name}: ${one.when}${one.not === undefined ? '' : ` Not: ${one.not}`}`).join('\n')
  return `You sort the newest request to an AI coding assistant. Never carry the request out. Answer with two words: the kind of job, then the effort. When unsure between two kinds, name the riskier one.\n\nKinds of job:\n${guide(routes.tasks)}\n\nEfforts:\n${guide(routes.efforts)}`
}

export function readHaiku(routes: Routes, text: string): Verdict {
  const named = <T extends { name: string }>(list: T[]) => list.find(one => new RegExp(`\\b${one.name}\\b`, 'i').test(text))
  const task = named(routes.tasks)
  const effort = named(routes.efforts)
  if (task === undefined || effort === undefined) throw new Error('Haiku named no route')
  return { task, effort: effort.name, via: `haiku, ${task.name}` }
}
