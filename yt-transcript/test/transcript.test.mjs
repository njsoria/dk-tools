import test from 'node:test'
import assert from 'node:assert/strict'
import { videoId, pickTrack, parseCues, decode } from '../lib/youtube.mjs'
import { toText, toSrt, clock, slug } from '../lib/format.mjs'

test('videoId reads every link shape and a bare id', () => {
  const id = 'dQw4w9WgXcQ'
  for (const input of [
    id,
    `https://www.youtube.com/watch?v=${id}&t=42s`,
    `youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}?si=abc`,
    `https://m.youtube.com/shorts/${id}`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube.com/live/${id}`,
  ]) assert.equal(videoId(input), id, input)
  for (const input of ['', 'hello', 'https://example.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/']) {
    assert.equal(videoId(input), null, input)
  }
})

test('pickTrack prefers human captions, then the exact language', () => {
  const tracks = [
    { lang: 'en', auto: true },
    { lang: 'en-GB', auto: false },
    { lang: 'de', auto: false },
  ]
  assert.deepEqual(pickTrack(tracks, 'en'), { lang: 'en-GB', auto: false })
  assert.deepEqual(pickTrack(tracks.slice(0, 1), 'en'), { lang: 'en', auto: true })
  assert.equal(pickTrack(tracks, 'ja'), null)
  assert.equal(pickTrack([], 'en'), null)
})

test('parseCues reads the <p> layout, strips word tags and decodes entities', () => {
  const xml = `<timedtext format="3"><body>
<p t="1360" d="1680">[♪♪♪]</p>
<p t="18640" d="3240">We&#39;re <s>no</s> strangers &amp; more
and so on</p>
<p t="30000" d="100"></p>
</body></timedtext>`
  assert.deepEqual(parseCues(xml), [
    { start: 1.36, end: 3.04, text: '[♪♪♪]' },
    { start: 18.64, end: 21.88, text: "We're no strangers & more and so on" },
  ])
})

test('parseCues reads the older <text start dur> layout', () => {
  const cues = parseCues('<transcript><text start="2.5" dur="1.5">hi &lt;there&gt;</text></transcript>')
  assert.deepEqual(cues, [{ start: 2.5, end: 4, text: 'hi <there>' }])
})

test('decode leaves unknown entities alone', () => {
  assert.equal(decode('a &#x41; &#66; &nope; &#99999999;'), 'a A B &nope; &#99999999;')
})

test('toText joins cues, or groups them into timestamped paragraphs', () => {
  const cues = [
    { start: 0, end: 5, text: 'one' },
    { start: 30, end: 35, text: 'two' },
    { start: 70, end: 75, text: 'three' },
    { start: 3700, end: 3705, text: 'four' },
  ]
  assert.equal(toText(cues), 'one two three four')
  assert.equal(toText(cues, { timestamps: true }), '[00:00] one two\n\n[01:10] three\n\n[1:01:40] four')
})

test('toSrt numbers cues and uses comma milliseconds', () => {
  const out = toSrt([{ start: 1.5, end: 3.25, text: 'hello' }])
  assert.equal(out, '1\n00:00:01,500 --> 00:00:03,250\nhello\n')
})

test('clock and slug', () => {
  assert.equal(clock(65), '01:05')
  assert.equal(clock(3725), '1:02:05')
  assert.equal(slug('How to Use Claude: the BEST Tips (2026)!'), 'how-to-use-claude-the-best-tips-2026')
  assert.equal(slug('???'), 'video')
})
