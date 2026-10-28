export function clock(seconds, { ms = false, comma = false } = {}) {
  const total = Math.max(0, seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = Math.floor(total % 60)
  const pad = (n) => String(n).padStart(2, '0')
  let out = h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
  if (ms) out = `${pad(h)}:${pad(m)}:${pad(s)}${comma ? ',' : '.'}${String(Math.round((total % 1) * 1000)).padStart(3, '0')}`
  return out
}

// Groups cues into paragraphs of about `window` seconds, each led by the time it starts.
export function paragraphs(cues, window = 60) {
  const out = []
  for (const cue of cues) {
    const last = out.at(-1)
    if (last && cue.start - last.start < window) last.text += ` ${cue.text}`
    else out.push({ start: cue.start, text: cue.text })
  }
  return out
}

export function toText(cues, { timestamps = false, window = 60 } = {}) {
  if (!timestamps) return cues.map((c) => c.text).join(' ')
  return paragraphs(cues, window)
    .map((p) => `[${clock(p.start)}] ${p.text}`)
    .join('\n\n')
}

export function toSrt(cues) {
  return cues
    .map((c, i) => `${i + 1}\n${clock(c.start, { ms: true, comma: true })} --> ${clock(c.end, { ms: true, comma: true })}\n${c.text}\n`)
    .join('\n')
}

export function toMarkdown(video, track, cues, { window = 60 } = {}) {
  const front = [
    '---',
    `title: ${JSON.stringify(video.title)}`,
    `channel: ${JSON.stringify(video.channel)}`,
    `url: ${video.url}`,
    `duration: ${clock(video.seconds)}`,
    `captions: ${track.lang}${track.auto ? ' (automatic)' : ''}`,
    '---',
  ].join('\n')
  return `${front}\n\n# ${video.title}\n\n${toText(cues, { timestamps: true, window })}\n`
}

export function toJson(video, track, cues) {
  return JSON.stringify({ ...video, tracks: undefined, captions: { lang: track.lang, auto: track.auto }, cues }, null, 2)
}

export function slug(text, max = 60) {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_-]+/g, '-')
      .slice(0, max)
      .replace(/-+$/, '') || 'video'
  )
}
