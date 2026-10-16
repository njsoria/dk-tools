import { usd, pct, day, n } from './model.mjs'

const signed = (x) => {
  const r = Math.round(x)
  return r === 0 ? '$0' : `${r < 0 ? '-' : '+'}$${Math.abs(r)}`
}
const pad = (s, w, right = false) => (right ? String(s).padStart(w) : String(s).padEnd(w))

function table(head, rows, rightCols) {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)))
  const line = (r) => r.map((c, i) => pad(c, widths[i], rightCols.includes(i))).join('  ').trimEnd()
  return [line(head), ...rows.map(line)].join('\n')
}

function wrap(text, width, indent) {
  const lines = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  if (line) lines.push(line)
  return lines.map((l) => indent + l).join('\n')
}

export function render(snap, a) {
  const { period: p, plan, thisPeriod } = a
  const out = []
  out.push(
    `${snap.team.name} · Netlify ${snap.team.planName}, ${n(plan.includedCredits)} credits a month` +
      ` · ${day(p.start)} to ${day(p.end)}, day ${Math.ceil(p.elapsed)} of ${Math.round(p.days)}`,
    '',
  )
  if (a.estimated) out.push("Netlify's billing endpoints didn't answer, so this counts production deploys only.", '')

  const balance = snap.billing
    ? `Balance ${n(a.available)} credits: ${n(snap.billing.plan.available)} of the plan, ${n(snap.billing.packs.available)} in packs.`
    : `About ${n(a.available)} plan credits left.`
  out.push(
    `${balance} At ${n(a.perDay)} a day ${a.runOut ? `they run out around ${day(a.runOut)}.` : `they last the period.`}`,
  )
  const packs = thisPeriod.bought + thisPeriod.morePacks
  out.push(
    `This period: ${usd(plan.base)} plan` +
      (packs ? ` + ${packs} ${packs === 1 ? 'pack' : 'packs'} (${usd(thisPeriod.total - plan.base)}) = ${usd(thisPeriod.total)}` : '') +
      `. A month at this pace costs ${usd(a.steady.total)}.` +
      (plan.autoTopup ? '' : ' Auto top-up is off.'),
    '',
  )

  out.push(
    table(
      ['Meter', 'this period', 'per day', 'projected', 'share'],
      [
        ...a.meters.map((m) => [m.label, n(m.now), n(m.perDay), n(m.projected), pct(m.share)]),
        ['Total', n(a.used), n(a.perDay), n(a.used + a.perDay * p.remaining), ''],
      ],
      [1, 2, 3, 4],
    ),
    '',
  )

  if (a.painSpots.length) {
    out.push('Pain spots')
    a.painSpots.forEach((s, i) => {
      out.push(`${pad(i + 1, 3, true)}. ${pad(s.severity, 6)} ${s.title}`)
      out.push(wrap(s.detail, 88, '            '))
    })
    if (a.painSpots.some((s) => s.brief)) out.push('', 'Print a spot\'s agent brief with `netlify-usage brief <number>`.')
    out.push('')
  }

  out.push(
    table(
      ['Site', 'deploys', 'a day', 'credits/mo', 'share', 'fns', 'db', 'saves', 'cheapest', 'net', 'verdict'],
      a.sites.map((s) => [
        s.name,
        s.current.production,
        s.deploysPerDay.toFixed(1),
        n(s.credits),
        pct(s.share),
        s.functions,
        s.database ? 'yes' : '',
        usd(s.saves),
        `${s.alternatives[0].name} ${usd(s.alternatives[0].cost)}`,
        signed(s.net),
        s.verdict,
      ]),
      [1, 2, 3, 4, 5, 7, 9],
    ),
    '',
  )
  out.push('Site credits count production deploys only. Netlify does not split database, function or request use by site.')
  for (const s of a.sites.filter((x) => x.verdict !== 'STAY')) out.push(`${s.verdict} ${s.name}: ${s.reason}.`)
  if (a.moveAll)
    out.push(
      `Moving ${a.moveAll.names.join(', ')}: Netlify ${usd(a.moveAll.before)} → ${usd(a.moveAll.after)} a month, ` +
        `new hosting ${usd(a.moveAll.altCost)}, net ${usd(a.moveAll.net)} a month (${usd(a.moveAll.net * 12)} a year). ` +
        'Worth it when the move costs less than a year of that.',
    )
  return out.join('\n')
}
