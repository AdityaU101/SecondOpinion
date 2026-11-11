import { AnimatePresence, motion } from 'motion/react'
import { useMemo, useState } from 'react'
import { biomarkers, type System } from '../data/biomarkers'
import { fmt, rangeText, statusOf, type Reading, type Report, type Status } from '../data/reports'
import { rawLine } from './Printout'

const EXPO = [0.16, 1, 0.3, 1] as const
const pct = (r: Reading, v: number) => Math.min(100, Math.max(0, ((v - r.min) / (r.max - r.min)) * 100))

const statusLabel: Record<Status, string> = { low: 'Below range', in: 'In range', high: 'Above range' }

/** Shape plus word, so status never depends on colour alone. */
function StatusMark({ status }: { status: Status }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm font-semibold ${status === 'in' ? 'text-ok' : 'text-flag'}`}>
      <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true">
        {status === 'in' ? <circle cx="6" cy="6" r="4.5" fill="currentColor" /> : <path d={status === 'low' ? 'M1 2.5h10L6 10.5z' : 'M1 9.5h10L6 1.5z'} fill="currentColor" />}
      </svg>
      {statusLabel[status]}
    </span>
  )
}

/** Healthy band on a scale, with the patient's value dropped onto it. */
function RangeBar({ r, delay }: { r: Reading; delay: number }) {
  const status = statusOf(r)
  const from = r.lo !== undefined ? pct(r, r.lo) : 0
  const to = r.hi !== undefined ? pct(r, r.hi) : 100
  const at = pct(r, r.value)
  return (
    <div className="relative pb-6 pt-7" role="img" aria-label={`${r.value}, healthy range ${rangeText(r)}`}>
      <div className="relative h-2 rounded-full bg-line">
        <motion.div
          className="absolute inset-y-0 rounded-full bg-ok/35"
          style={{ left: `${from}%`, right: `${100 - to}%`, originX: 0 }}
          initial={{ scaleX: 0 }}
          whileInView={{ scaleX: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.7, ease: EXPO, delay }}
        />
        <motion.div
          className="absolute top-1/2"
          initial={{ left: `${(from + to) / 2}%`, opacity: 0 }}
          whileInView={{ left: `${at}%`, opacity: 1 }}
          viewport={{ once: true }}
          transition={{ left: { type: 'spring', stiffness: 90, damping: 14, delay: delay + 0.35 }, opacity: { duration: 0.2, delay: delay + 0.3 } }}
        >
          <span className={`absolute -left-2 -top-2 block h-4 w-4 rounded-full border-[3px] border-paper ${status === 'in' ? 'bg-ok' : 'bg-flag'} shadow-sm`} />
          <span className={`absolute -top-8 left-0 -translate-x-1/2 whitespace-nowrap text-sm font-semibold tabular-nums ${status === 'in' ? 'text-ok' : 'text-flag'}`}>You · {fmt(r)}</span>
        </motion.div>
      </div>
      {r.lo !== undefined && <span className="lab absolute bottom-0 -translate-x-1/2 text-mute" style={{ left: `${from}%` }}>{r.lo}</span>}
      {r.hi !== undefined && <span className="lab absolute bottom-0 -translate-x-1/2 text-mute" style={{ left: `${to}%` }}>{r.hi}</span>}
    </div>
  )
}

function Row({ r, index }: { r: Reading; index: number }) {
  const [open, setOpen] = useState(false)
  const b = biomarkers[r.key]
  const status = statusOf(r)
  const raw = rawLine(r)
  const direction = status === 'low' ? b.low : status === 'high' ? b.high : undefined
  const foods = b.foods && b.foods.when === status ? b.foods : null

  return (
    <motion.li
      className="grid gap-x-8 border-t border-line py-6 lg:grid-cols-[12.5rem_minmax(0,1fr)]"
      initial={{ opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '0px 0px -8% 0px' }}
      transition={{ duration: 0.6, ease: EXPO }}
    >
      {/* The original line, kept in the margin */}
      <p className="lab mb-3 flex gap-3 text-mute lg:mb-0 lg:block lg:pt-1.5">
        <span className="font-medium text-ink">{raw.abbr}</span>
        <span className="lg:mt-1 lg:block">
          {raw.value} {raw.flag && <span className="font-medium text-flag">{raw.flag}</span>}
        </span>
        <span className="lg:block">{raw.ref} {raw.unit}</span>
      </p>

      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h3 className="text-xl font-semibold tracking-tight">{b.name}</h3>
          <StatusMark status={status} />
        </div>
        <p className="plain mt-1 text-[1.1875rem] leading-snug text-mute">{b.what}</p>

        <RangeBar r={r} delay={0.1 + (index % 3) * 0.05} />

        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="group -mx-2 mt-1 flex min-h-11 items-center gap-2 rounded px-2 text-sm font-semibold"
        >
          <span className="relative block h-3 w-3" aria-hidden="true">
            <span className="absolute left-0 top-1/2 h-0.5 w-3 -translate-y-1/2 bg-ink" />
            <motion.span className="absolute left-1/2 top-0 h-3 w-0.5 -translate-x-1/2 bg-ink" animate={{ scaleY: open ? 0 : 1 }} transition={{ duration: 0.2 }} />
          </span>
          <span className="underline decoration-line decoration-2 underline-offset-4 transition-colors group-hover:decoration-ink">
            {open ? 'Hide explanation' : 'Explain this value'}
          </span>
        </button>

        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.4, ease: EXPO }}
              className="overflow-hidden"
            >
              <dl className="mt-3 grid gap-x-8 gap-y-4 rounded-lg bg-paper p-5 ring-1 ring-line md:grid-cols-2">
                <div>
                  <dt className="eyebrow">Why it matters</dt>
                  <dd className="plain mt-1 text-lg leading-snug">{b.why}</dd>
                </div>
                {direction && (
                  <div>
                    <dt className="eyebrow">When it is {status === 'low' ? 'low' : 'high'}</dt>
                    <dd className="plain mt-1 text-lg leading-snug">{direction}</dd>
                  </div>
                )}
                {foods && (
                  <div className="md:col-span-2">
                    <dt className="eyebrow">Everyday foods that support it</dt>
                    <dd className="mt-2">
                      <ul className="flex flex-wrap gap-2">
                        {foods.items.map((f) => (
                          <li key={f} className="rounded-full bg-ok-soft px-3 py-1 text-sm font-medium text-ok">{f}</li>
                        ))}
                      </ul>
                      <p className="mt-2 text-sm text-mute">{foods.note}</p>
                    </dd>
                  </div>
                )}
                <div className="md:col-span-2">
                  <dt className="eyebrow">Source</dt>
                  <dd className="mt-1 text-sm text-mute">{b.source}</dd>
                </div>
              </dl>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.li>
  )
}

function Trend({ trend }: { trend: NonNullable<Report['trend']> }) {
  const b = biomarkers[trend.key]
  const vals = trend.points.map((p) => p.value)
  const lo = Math.min(...vals) - 0.3
  const hi = Math.max(...vals) + 0.3
  const x = (i: number) => 40 + (i * 320) / (trend.points.length - 1)
  const y = (v: number) => 110 - ((v - lo) / (hi - lo)) * 80
  const d = trend.points.map((p, i) => `${i ? 'L' : 'M'}${x(i)} ${y(p.value)}`).join('')
  return (
    <section className="grid items-center gap-6 rounded-lg bg-paper p-6 ring-1 ring-line md:grid-cols-[1fr_1.1fr]">
      <div>
        <p className="eyebrow">Since your last reports</p>
        <p className="plain mt-2 text-2xl leading-snug">{trend.sentence}</p>
        <p className="mt-2 text-sm text-mute">Built only from the values in your saved reports.</p>
      </div>
      <svg viewBox="0 0 400 150" className="w-full" role="img" aria-label={`${b.name} trend: ${trend.points.map((p) => `${p.date} ${p.value}`).join(', ')}`}>
        <line x1="20" x2="380" y1={y(5.7)} y2={y(5.7)} stroke="var(--color-flag)" strokeDasharray="3 4" strokeWidth="1" />
        <text x="380" y={y(5.7) - 6} textAnchor="end" className="lab" fill="var(--color-flag)">5.7 pre-diabetes line</text>
        <motion.path d={d} fill="none" stroke="var(--color-ink)" strokeWidth="2" initial={{ pathLength: 0 }} whileInView={{ pathLength: 1 }} viewport={{ once: true }} transition={{ duration: 1.1, ease: EXPO }} />
        {trend.points.map((p, i) => (
          <motion.g key={p.date} initial={{ opacity: 0, scale: 0.4 }} whileInView={{ opacity: 1, scale: 1 }} viewport={{ once: true }} transition={{ delay: 0.3 + i * 0.3 }} style={{ transformOrigin: `${x(i)}px ${y(p.value)}px` }}>
            <circle cx={x(i)} cy={y(p.value)} r="5" fill="var(--color-paper)" stroke="var(--color-ink)" strokeWidth="2" />
            <text x={x(i)} y={y(p.value) - 12} textAnchor="middle" className="text-[13px] font-semibold" fill="var(--color-ink)">{p.value}%</text>
            <text x={x(i)} y="140" textAnchor="middle" className="lab" fill="var(--color-mute)">{p.date}</text>
          </motion.g>
        ))}
      </svg>
    </section>
  )
}

export function ReportView({ report, onBack }: { report: Report; onBack: () => void }) {
  const [copied, setCopied] = useState(false)
  const flagged = report.readings.filter((r) => statusOf(r) !== 'in')
  const ordered = [...flagged, ...report.readings.filter((r) => statusOf(r) === 'in')]
  const systems = useMemo(() => {
    const m = new Map<System, Status[]>()
    report.readings.forEach((r) => m.set(biomarkers[r.key].system, [...(m.get(biomarkers[r.key].system) ?? []), statusOf(r)]))
    return [...m.entries()]
  }, [report])
  const sources = [...new Set(report.readings.map((r) => biomarkers[r.key].source))]

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report.questions.map((q, i) => `${i + 1}. ${q}`).join('\n'))
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <motion.article initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }} className="mx-auto max-w-5xl px-5 pb-24 pt-8 md:px-8">
      <button type="button" onClick={onBack} className="-ml-2 flex min-h-11 items-center gap-2 rounded px-2 text-sm font-semibold text-mute transition-colors hover:text-ink">
        <span aria-hidden="true">←</span> Another report
      </button>

      <header className="mt-6">
        <p className="lab text-mute">{report.patient.toUpperCase()} · {report.date.toUpperCase()}</p>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight md:text-5xl">{report.title}</h1>
        <motion.p className="plain mt-6 max-w-3xl text-[1.6rem] leading-[1.3] md:text-[2rem]" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease: EXPO, delay: 0.1 }}>
          {report.summary}
        </motion.p>
      </header>

      <motion.div className="mt-8 grid gap-4 md:grid-cols-[1.2fr_1fr]" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease: EXPO, delay: 0.2 }}>
        <div className="rounded-lg bg-flag-soft p-5">
          <p className="eyebrow !text-flag">{report.urgency.level}</p>
          <p className="mt-1.5 font-medium leading-snug">{report.urgency.text}</p>
        </div>
        <div className="rounded-lg bg-paper p-5 ring-1 ring-line">
          <p className="eyebrow">By body system</p>
          <ul className="mt-2 space-y-1.5">
            {systems.map(([name, list]) => (
              <li key={name} className="flex items-center justify-between gap-4 text-sm">
                <span className="font-medium">{name}</span>
                <span className="flex items-center gap-2 text-mute">
                  <span className="flex gap-1" aria-hidden="true">
                    {list.map((s, i) => (
                      <span key={i} className={`h-2.5 w-2.5 ${s === 'in' ? 'rounded-full bg-ok' : 'rotate-45 bg-flag'}`} />
                    ))}
                  </span>
                  {list.filter((s) => s === 'in').length} of {list.length} in range
                </span>
              </li>
            ))}
          </ul>
        </div>
      </motion.div>

      <section className="mt-14">
        <div className="mb-2 grid gap-x-8 lg:grid-cols-[12.5rem_minmax(0,1fr)]">
          <p className="eyebrow hidden lg:block">As the lab wrote it</p>
          <p className="eyebrow">In plain English · {flagged.length} of {report.readings.length} outside range, shown first</p>
        </div>
        <ul>
          {ordered.map((r, i) => (
            <Row key={r.key} r={r} index={i} />
          ))}
        </ul>
      </section>

      {report.trend && <div className="mt-10"><Trend trend={report.trend} /></div>}

      <section className="mt-14 grid gap-x-8 gap-y-4 border-t border-ink pt-8 lg:grid-cols-[12.5rem_minmax(0,1fr)]">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Questions for your doctor</h2>
          <button type="button" onClick={copy} className="mt-2 min-h-11 text-sm font-semibold underline decoration-line decoration-2 underline-offset-4 hover:decoration-ink">
            <span aria-live="polite">{copied ? 'Copied' : 'Copy the list'}</span>
          </button>
        </div>
        <ol className="plain space-y-4 text-[1.375rem] leading-snug">
          {report.questions.map((q, i) => (
            <motion.li key={q} className="grid grid-cols-[2.25rem_1fr]" initial={{ opacity: 0, x: -8 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true }} transition={{ duration: 0.5, ease: EXPO, delay: i * 0.06 }}>
              <span className="lab pt-2 text-mute">{String(i + 1).padStart(2, '0')}</span>
              {q}
            </motion.li>
          ))}
        </ol>
      </section>

      <section className="mt-14 grid gap-x-8 gap-y-3 border-t border-line pt-8 lg:grid-cols-[12.5rem_minmax(0,1fr)]">
        <h2 className="eyebrow">Sources cited</h2>
        <ul className="grid gap-x-8 gap-y-1.5 text-sm text-mute sm:grid-cols-2">
          {sources.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </section>

      <p className="mt-12 rounded-lg bg-ink p-5 text-sm leading-relaxed text-paper/90">
        <strong className="text-paper">ClearChart is a health-literacy tool, not a diagnostic one.</strong> It explains what a report says so you can have a
        better conversation with your clinician. It does not diagnose or prescribe. Reference ranges vary between laboratories. Every report on this page
        is invented sample data.
      </p>
    </motion.article>
  )
}
