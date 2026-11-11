import { AnimatePresence, motion } from 'motion/react'
import { biomarkers } from '../data/biomarkers'
import { fmt, rangeText, statusOf, type Report } from '../data/reports'

export const rawLine = (r: Report['readings'][number]) => {
  const b = biomarkers[r.key]
  const s = statusOf(r)
  return { abbr: b.abbr, value: fmt(r), flag: s === 'low' ? 'L' : s === 'high' ? 'H' : '', ref: rangeText(r), unit: b.unit }
}

/** The report as the lab prints it: abbreviations, flags, no explanation. */
export function Printout({ report, scanning }: { report: Report; scanning: number | null }) {
  return (
    <div className="relative rotate-[0.6deg] overflow-hidden rounded-sm bg-paper p-5 shadow-[0_1px_0_#fff_inset,0_30px_60px_-30px_rgb(15_46_39/0.35)] ring-1 ring-line md:p-7">
      <AnimatePresence mode="wait">
        <motion.div key={report.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
          <div className="lab flex justify-between border-b border-dashed border-ink/30 pb-3 text-mute">
            <span>
              LABORATORY REPORT
              <br />
              {report.patient.toUpperCase()}
            </span>
            <span className="text-right">
              COLLECTED
              <br />
              {report.date.toUpperCase()}
            </span>
          </div>
          <table className="lab mt-3 w-full">
            <thead>
              <tr className="text-left text-mute">
                <th className="py-1 font-normal">TEST</th>
                <th className="py-1 text-right font-normal">RESULT</th>
                <th className="w-8 py-1 text-center font-normal">FL</th>
                <th className="py-1 font-normal">REF</th>
                <th className="hidden py-1 font-normal sm:table-cell">UNITS</th>
              </tr>
            </thead>
            <tbody>
              {report.readings.map((r, i) => {
                const l = rawLine(r)
                return (
                  <tr key={r.key} className="relative">
                    <td className="relative py-1.5 font-medium">
                      {scanning === i && <motion.span layoutId="scan" className="absolute -inset-x-2 inset-y-0 -z-0 w-[60rem] bg-flag-soft" transition={{ duration: 0.18 }} />}
                      <span className="relative">{l.abbr}</span>
                    </td>
                    <td className="relative py-1.5 text-right tabular-nums">{l.value}</td>
                    <td className="relative py-1.5 text-center font-medium text-flag">{l.flag}</td>
                    <td className="relative py-1.5 text-mute">{l.ref}</td>
                    <td className="relative hidden py-1.5 text-mute sm:table-cell">{l.unit}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="lab mt-4 border-t border-dashed border-ink/30 pt-3 text-mute">*** END OF REPORT · SAMPLE DATA ***</p>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
