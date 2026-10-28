#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { videoId, fetchVideo, pickTrack, fetchCues } from '../lib/youtube.mjs'
import { toText, toSrt, toMarkdown, toJson, slug, clock } from '../lib/format.mjs'

const defaultDir = path.join(os.homedir(), '.local', 'share', 'yt-transcript')

const HELP = `yt-transcript: get the transcript of a YouTube video

  yt-transcript <url|id> [more urls...]

  --lang <code>      caption language (default: en). Human captions win over automatic ones
  --format <name>    md (default), text, srt or json
  --save             write each transcript to a file instead of printing it
  --out-dir <dir>    where --save writes (default: ${defaultDir})
  --window <secs>    seconds per timestamped paragraph in md (default: 60)
  --list             list the caption languages a video has, and stop

md is the one to hand to an agent: a header with the title, channel and link, then
paragraphs that each begin [mm:ss]. text is the words alone, srt is for a video editor,
json keeps every cue with its start and end.`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    lang: { type: 'string', default: 'en' },
    format: { type: 'string', default: 'md' },
    save: { type: 'boolean' },
    'out-dir': { type: 'string', default: defaultDir },
    window: { type: 'string', default: '60' },
    list: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
})

const FORMATS = { md: 'md', text: 'txt', srt: 'srt', json: 'json' }

function render(video, track, cues) {
  const window = Number(values.window) || 60
  switch (values.format) {
    case 'md': return toMarkdown(video, track, cues, { window })
    case 'text': return `${toText(cues)}\n`
    case 'srt': return toSrt(cues)
    case 'json': return `${toJson(video, track, cues)}\n`
  }
}

async function one(input) {
  const id = videoId(input)
  if (!id) throw new Error(`"${input}" is not a YouTube link or video id`)
  const video = await fetchVideo(id)

  if (values.list) {
    console.log(`${video.title} (${clock(video.seconds)})`)
    if (!video.tracks.length) console.log('  no captions')
    for (const t of video.tracks) console.log(`  ${t.lang}${t.auto ? '  automatic' : ''}  ${t.name}`)
    return
  }

  const track = pickTrack(video.tracks, values.lang)
  if (!track) {
    const have = video.tracks.map((t) => (t.auto ? `${t.lang} (auto)` : t.lang)).join(', ') || 'none'
    throw new Error(`${id} has no "${values.lang}" captions (it has: ${have}). Try --list, or --lang with one of those.`)
  }
  const cues = await fetchCues(track)
  if (!cues.length) throw new Error(`${id}: the ${track.lang} captions came back empty`)
  const body = render(video, track, cues)

  if (!values.save) return process.stdout.write(body)
  fs.mkdirSync(values['out-dir'], { recursive: true })
  const file = path.join(values['out-dir'], `${slug(video.title)}-${id}.${FORMATS[values.format]}`)
  fs.writeFileSync(file, body)
  console.log(file)
}

async function main() {
  if (values.help || !positionals.length) return console.log(HELP)
  if (!FORMATS[values.format]) throw new Error(`--format must be one of: ${Object.keys(FORMATS).join(', ')}`)
  let failed = false
  for (const input of positionals) {
    try {
      await one(input)
    } catch (err) {
      failed = true
      console.error(`yt-transcript: ${err.message}`)
    }
  }
  if (failed) process.exitCode = 1
}

main()
