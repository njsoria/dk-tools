const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false'
const CLIENT = { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 34, hl: 'en' }
const USER_AGENT = 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip'

const ID = /^[\w-]{11}$/

// Accepts a watch, short, embed, live or youtu.be link, or a bare 11-character id.
export function videoId(input) {
  const text = String(input).trim()
  if (ID.test(text)) return text
  let url
  try {
    url = new URL(text.includes('://') ? text : `https://${text}`)
  } catch {
    return null
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '')
  let id = null
  if (host === 'youtu.be') id = url.pathname.split('/')[1]
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.searchParams.get('v')
    const [, kind, rest] = url.pathname.split('/')
    if (!id && ['embed', 'shorts', 'live', 'v'].includes(kind)) id = rest
  }
  return ID.test(id ?? '') ? id : null
}

// The player response carries the title, channel, length and the caption tracks.
export async function fetchVideo(id, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(PLAYER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify({ context: { client: CLIENT }, videoId: id }),
  })
  if (!res.ok) throw new Error(`YouTube answered ${res.status} for ${id}`)
  const data = await res.json()
  const status = data.playabilityStatus?.status
  if (status && status !== 'OK') {
    const why = data.playabilityStatus.reason ?? status
    throw new Error(`${id} is not playable here: ${why}. For age-restricted or members-only videos, download the captions with yt-dlp and --cookies-from-browser.`)
  }
  const details = data.videoDetails ?? {}
  const tracks = (data.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []).map((t) => ({
    lang: t.languageCode,
    name: t.name?.simpleText ?? t.name?.runs?.map((r) => r.text).join('') ?? t.languageCode,
    auto: t.kind === 'asr',
    url: t.baseUrl,
  }))
  return {
    id,
    title: details.title ?? id,
    channel: details.author ?? '',
    seconds: Number(details.lengthSeconds) || 0,
    url: `https://www.youtube.com/watch?v=${id}`,
    tracks,
  }
}

// Picks the caption track for a language: a human-made one before an automatic one,
// an exact language code before a regional variant ("en" before "en-GB").
export function pickTrack(tracks, lang = 'en') {
  const want = lang.toLowerCase()
  const base = want.split('-')[0]
  const rank = (t) => {
    const code = t.lang.toLowerCase()
    if (code.split('-')[0] !== base) return Infinity
    return (t.auto ? 2 : 0) + (code === want ? 0 : 1)
  }
  const [best] = [...tracks].sort((a, b) => rank(a) - rank(b))
  return best && rank(best) < Infinity ? best : null
}

export async function fetchCues(track, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(track.url, { headers: { 'user-agent': USER_AGENT } })
  if (!res.ok) throw new Error(`YouTube answered ${res.status} for the ${track.lang} captions`)
  return parseCues(await res.text())
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

export function decode(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

// Reads both caption layouts YouTube serves: <p t="ms" d="ms"> and <text start="s" dur="s">.
export function parseCues(xml) {
  const cues = []
  const re = /<(p|text)\b([^>]*)>([\s\S]*?)<\/\1>/g
  for (const [, tag, attrs, inner] of xml.matchAll(re)) {
    const attr = (name) => Number(new RegExp(`\\b${name}="([\\d.]+)"`).exec(attrs)?.[1])
    const start = tag === 'p' ? attr('t') / 1000 : attr('start')
    const length = tag === 'p' ? attr('d') / 1000 : attr('dur')
    if (!Number.isFinite(start)) continue
    const text = decode(inner.replace(/<[^>]+>/g, ''))
      .replace(/\s*\n\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
    const end = Math.round((start + (Number.isFinite(length) ? length : 0)) * 1000) / 1000
    if (text) cues.push({ start, end, text })
  }
  return cues
}
