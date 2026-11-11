import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { Printout } from './components/Printout'
import { ReportView } from './components/ReportView'
import { reports } from './data/reports'

const EXPO = [0.16, 1, 0.3, 1] as const
const REPO = 'https://github.com/AdityaU101/SecondOpinion'
const STEPS = ['Reading the document', 'Checking each value against its range', 'Retrieving clinical guidelines', 'Writing the explanation']

export default function App() {
  const reduce = useReducedMotion()
  const [pick, setPick] = useState(reports[0].id)
  const [phase, setPhase] = useState<'pick' | 'working' | 'report'>('pick')
  const [scan, setScan] = useState<number | null>(null)
  const [step, setStep] = useState(0)
  const timers = useRef<number[]>([])
  const report = reports.find((r) => r.id === pick)!

  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  const explain = () => {
    timers.current.forEach(clearTimeout)
    setPhase('working')
    setStep(0)
    const n = report.readings.length
    const tick = reduce ? 30 : 170
    const t: number[] = []
    // Step 1 and 2: a highlight walks down the printout, line by line.
    for (let i = 0; i < n; i++) t.push(window.setTimeout(() => { setScan(i); if (i === 2) setStep(1) }, 300 + i * tick))
    const after = 300 + n * tick
    t.push(window.setTimeout(() => { setScan(null); setStep(2) }, after))
    t.push(window.setTimeout(() => setStep(3), after + (reduce ? 60 : 650)))
    t.push(window.setTimeout(() => { setPhase('report'); window.scrollTo({ top: 0 }) }, after + (reduce ? 120 : 1400)))
    timers.current = t
  }

  return (
    <MotionConfig reducedMotion="user">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5 md:px-8">
        <a href="/" className="flex items-center gap-2.5 text-lg font-bold tracking-tight">
          <svg viewBox="0 0 28 12" className="h-3 w-7" aria-hidden="true">
            <rect y="4" width="28" height="4" rx="2" fill="var(--color-line)" />
            <rect x="8" y="4" width="11" height="4" fill="var(--color-ok)" opacity="0.5" />
            <circle cx="22" cy="6" r="4.5" fill="var(--color-flag)" stroke="var(--color-ground)" strokeWidth="2" />
          </svg>
          ClearChart
        </a>
        <p className="flex items-center gap-5 text-sm">
          <span className="rounded-full bg-flag-soft px-3 py-1 font-semibold text-flag">Demo · sample reports</span>
          <a href={REPO} target="_blank" rel="noreferrer" className="hidden font-semibold underline decoration-line decoration-2 underline-offset-4 hover:decoration-ink sm:inline">Source</a>
        </p>
      </header>

      <main>
        <AnimatePresence mode="wait">
          {phase !== 'report' ? (
            <motion.section key="pick" exit={{ opacity: 0, transition: { duration: 0.2 } }} className="mx-auto grid max-w-6xl items-start gap-x-16 gap-y-12 px-5 pb-24 pt-8 md:px-8 md:pt-16 lg:grid-cols-[1.05fr_1fr]">
              <div>
                <h1 className="text-[clamp(2.6rem,6vw,4.75rem)] font-semibold leading-[0.98] tracking-[-0.035em]">
                  {['Your lab report,', 'in'].map((l, i) => (
                    <span key={l} className={i ? 'inline' : 'block'}>{l} </span>
                  ))}
                  <motion.em className="plain font-normal italic tracking-[-0.02em] text-ok" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1, delay: 0.3 }}>
                    plain English.
                  </motion.em>
                </h1>
                <p className="plain mt-6 max-w-lg text-[1.375rem] leading-snug text-mute">
                  What each value means, which ones are outside range, and what to ask your doctor. Every claim is tied to a published guideline.
                </p>

                <fieldset className="mt-10" disabled={phase === 'working'}>
                  <legend className="eyebrow mb-3">Choose a sample report</legend>
                  <div className="divide-y divide-line border-y border-line">
                    {reports.map((r) => {
                      const on = pick === r.id
                      return (
                        <label key={r.id} className="group relative flex min-h-16 cursor-pointer items-center gap-4 py-3">
                          <input type="radio" name="report" value={r.id} checked={on} onChange={() => setPick(r.id)} className="peer sr-only" />
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-ink peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2">
                            <motion.span className="h-2.5 w-2.5 rounded-full bg-ink" initial={false} animate={{ scale: on ? 1 : 0 }} transition={{ type: 'spring', stiffness: 500, damping: 28 }} />
                          </span>
                          <span className="transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:translate-x-1">
                            <span className="block text-lg font-semibold leading-tight">{r.title}</span>
                            <span className="block text-sm text-mute">{r.lab}</span>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </fieldset>

                <motion.button
                  type="button"
                  onClick={explain}
                  disabled={phase === 'working'}
                  whileTap={{ scale: 0.98 }}
                  className="mt-8 flex h-14 w-full items-center justify-center rounded-full bg-ink px-8 text-base font-semibold leading-tight text-paper transition-colors hover:bg-ok sm:text-lg disabled:cursor-progress sm:w-auto"
                >
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span key={phase === 'working' ? step : 'go'} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.18 }}>
                      {phase === 'working' ? `${STEPS[step]}…` : 'Explain this report'}
                    </motion.span>
                  </AnimatePresence>
                </motion.button>
                <p className="mt-4 max-w-md text-sm text-mute">
                  The full app takes a PDF, photo or pasted text. This demo runs in your browser on three invented reports. It is a health-literacy tool, not a diagnosis.
                </p>
              </div>

              <motion.div initial={{ opacity: 0, y: 24, rotate: 2 }} animate={{ opacity: 1, y: 0, rotate: 0 }} transition={{ duration: 0.9, ease: EXPO, delay: 0.15 }} className="lg:pt-6">
                <p className="eyebrow mb-3">What the lab sends you</p>
                <Printout report={report} scanning={scan} />
                <p role="status" className="sr-only">{phase === 'working' ? STEPS[step] : ''}</p>
              </motion.div>
            </motion.section>
          ) : (
            <ReportView key="report" report={report} onBack={() => { setPhase('pick'); setScan(null) }} />
          )}
        </AnimatePresence>
      </main>
    </MotionConfig>
  )
}
