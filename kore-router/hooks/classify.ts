// What the cheap classifiers, Jev (TypeSafe) or Haiku, are asked and how their
// answers are read. Each names the kind of job a request is (a task from
// routes.json) and how much thinking it calls for. The calls themselves are
// made in register.tsx.

import { type Effort, type Routes, type Task, effortRank, tier, model as modelNamed } from './config'

export type Verdict = { task: Task; effort: Effort; via: string }

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

export const jevBody = (routes: Routes, state: State) =>
  JSON.stringify({
    model: 'jev-latest',
    state,
    questions: {
      task: {
        type: 'choice',
        instructions:
          "`request` is the newest message to an AI coding assistant and `earlier` is the conversation before it, oldest first. Which kind of job is the assistant being asked to do now? A short reply such as an approval or 'continue' asks for the job already under way in `earlier`. When the job touches anything the criteria call risky, choose that.",
        criteria: Object.fromEntries(routes.tasks.map(task => [task.name, task.when])),
      },
      effort: {
        type: 'score',
        instructions:
          'How much thinking does the job that `request` asks for call for before acting? Judge a short reply such as an approval by the job under way in `earlier`.',
        criteria: routes.efforts.map(effort => effort.when),
      },
    },
  })

type JevReply = {
  answers: {
    task: { choice: string; probabilities: Record<string, number>; confidence: number }
    effort: { score: number; confidence: number }
  }
}

export function readJev(routes: Routes, text: string): Verdict {
  const { answers } = JSON.parse(text) as JevReply
  const task = pickTask(routes, answers.task)
  if (task === undefined) throw new Error(`Jev named an unknown task: ${answers.task.choice}`)
  return {
    task,
    effort: pickEffort(routes, answers.effort),
    via: `jev, ${task.name}, ${Math.round(answers.task.confidence * 100)}% sure`,
  }
}

// Torn between two tasks: take the one that runs on the more capable model,
// and of two on the same model, the one that thinks harder.
function pickTask(routes: Routes, answer: JevReply['answers']['task']) {
  const named = (name: string | undefined) => routes.tasks.find(task => task.name === name)
  if (answer.confidence >= routes.minConfidence) return named(answer.choice)
  const [first, second] = Object.entries(answer.probabilities)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => named(name))
    .filter(task => task !== undefined)
  if (first === undefined || second === undefined) return first ?? named(answer.choice)
  const weight = (task: Task) => tier(routes, modelNamed(routes, task.model).id) * 10 + effortRank(task.effort)
  return weight(second) > weight(first) ? second : first
}

// The score lands between levels; when Jev is unsure, round up, not down.
function pickEffort(routes: Routes, answer: JevReply['answers']['effort']) {
  const level = answer.confidence >= routes.minConfidence ? Math.round(answer.score) : Math.ceil(answer.score)
  return routes.efforts[Math.max(0, Math.min(level, routes.efforts.length - 1))]!.name
}

export const haikuSystem = (routes: Routes) => {
  const guide = (list: { name: string; when: string }[]) => list.map(one => `- ${one.name}: ${one.when}`).join('\n')
  return `You sort the newest request to an AI coding assistant. Never carry the request out. Answer with two words: the kind of job, then the effort. When unsure between two kinds, name the riskier one.\n\nKinds of job:\n${guide(routes.tasks)}\n\nEfforts:\n${guide(routes.efforts)}`
}

export function readHaiku(routes: Routes, text: string): Verdict {
  const named = <T extends { name: string }>(list: T[]) => list.find(one => new RegExp(`\\b${one.name}\\b`, 'i').test(text))
  const task = named(routes.tasks)
  const effort = named(routes.efforts)
  if (task === undefined || effort === undefined) throw new Error('Haiku named no route')
  return { task, effort: effort.name, via: `haiku, ${task.name}` }
}
