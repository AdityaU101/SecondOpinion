export interface Reading {
  key: string
  value: number
  /** Healthy range. A missing side means the range is open on that side. */
  lo?: number
  hi?: number
  /** Ends of the drawn scale. */
  min: number
  max: number
}

export interface Report {
  id: string
  title: string
  patient: string
  date: string
  lab: string
  urgency: { level: 'Routine' | 'Discuss soon'; text: string }
  summary: string
  readings: Reading[]
  questions: string[]
  trend?: { key: string; points: { date: string; value: number }[]; sentence: string }
}

/** All three reports are invented sample data. No real patient is described. */
export const reports: Report[] = [
  {
    id: 'checkup',
    title: 'Annual check-up',
    patient: 'Sample patient A · F · 34',
    date: '14 Oct 2026',
    lab: 'CBC, iron studies, vitamin D, TSH',
    urgency: { level: 'Discuss soon', text: 'Nothing here is an emergency. Three related values are low and worth raising at your next visit.' },
    summary:
      'Most of this report is in range. Hemoglobin, red cell size and ferritin are all low together, a pattern that often goes with low iron stores. Vitamin D is slightly low too.',
    readings: [
      { key: 'hgb', value: 10.9, lo: 12.0, hi: 15.5, min: 8, max: 18 },
      { key: 'mcv', value: 76, lo: 80, hi: 100, min: 65, max: 115 },
      { key: 'ferritin', value: 8, lo: 12, hi: 150, min: 0, max: 200 },
      { key: 'wbc', value: 6.2, lo: 4.5, hi: 11.0, min: 2, max: 14 },
      { key: 'plt', value: 312, lo: 150, hi: 450, min: 50, max: 550 },
      { key: 'vitd', value: 18, lo: 20, hi: 50, min: 5, max: 70 },
      { key: 'tsh', value: 2.1, lo: 0.4, hi: 4.0, min: 0, max: 8 },
      { key: 'glucose', value: 88, lo: 70, hi: 99, min: 50, max: 150 },
    ],
    questions: [
      'My hemoglobin, MCV and ferritin are all low. Could these be related, and what might be causing it?',
      'Should we check B12 and folate as well as iron?',
      'Would an iron supplement make sense for me, and for how long?',
      'Is my vitamin D low enough to need a supplement?',
      'When should these tests be repeated?',
    ],
  },
  {
    id: 'metabolic',
    title: 'Metabolic and lipid panel',
    patient: 'Sample patient B · M · 52',
    date: '02 Nov 2026',
    lab: 'Lipid panel, glucose, HbA1c, ALT, creatinine',
    urgency: { level: 'Discuss soon', text: 'Nothing here is an emergency. Cholesterol and blood sugar are both above range and have been drifting upward.' },
    summary:
      'Liver and kidney values are in range. LDL cholesterol and triglycerides are high and HDL is low. Fasting glucose and HbA1c both sit in the range described as pre-diabetes.',
    readings: [
      { key: 'chol', value: 238, hi: 200, min: 100, max: 300 },
      { key: 'ldl', value: 162, hi: 100, min: 40, max: 220 },
      { key: 'hdl', value: 38, lo: 40, min: 20, max: 90 },
      { key: 'tg', value: 210, hi: 150, min: 40, max: 320 },
      { key: 'glucose', value: 112, lo: 70, hi: 99, min: 50, max: 150 },
      { key: 'a1c', value: 6.1, hi: 5.6, min: 4.5, max: 8 },
      { key: 'alt', value: 41, lo: 7, hi: 56, min: 0, max: 90 },
      { key: 'creat', value: 1.0, lo: 0.7, hi: 1.3, min: 0.3, max: 2 },
    ],
    questions: [
      'My LDL is 162. What target makes sense for me, given my other risk factors?',
      'Should we estimate my 10-year cardiovascular risk?',
      'My HbA1c has gone from 5.6 to 6.1 over three reports. What would you suggest to slow that?',
      'Would a lifestyle programme be the first step, or should we talk about medication?',
      'How soon should the lipid panel and HbA1c be repeated?',
    ],
    trend: {
      key: 'a1c',
      points: [
        { date: 'Nov 2024', value: 5.6 },
        { date: 'Nov 2025', value: 5.9 },
        { date: 'Nov 2026', value: 6.1 },
      ],
      sentence: 'HbA1c has risen at each of the last three reports, from 5.6% to 6.1%.',
    },
  },
  {
    id: 'kidney',
    title: 'Kidney and thyroid follow-up',
    patient: 'Sample patient C · F · 61',
    date: '28 Oct 2026',
    lab: 'Renal panel, TSH, free T4, hemoglobin, vitamin D',
    urgency: { level: 'Discuss soon', text: 'Nothing here is an emergency. Kidney filtering is below range and TSH is raised; both are worth a follow-up conversation.' },
    summary:
      'Blood count, potassium and vitamin D are in range. Creatinine and urea are high and eGFR is below 60, which together describe reduced kidney filtering. TSH is high while free T4 remains in range.',
    readings: [
      { key: 'creat', value: 1.3, lo: 0.6, hi: 1.1, min: 0.3, max: 2 },
      { key: 'egfr', value: 52, lo: 60, min: 15, max: 120 },
      { key: 'bun', value: 24, lo: 7, hi: 20, min: 0, max: 40 },
      { key: 'k', value: 4.6, lo: 3.5, hi: 5.0, min: 2.5, max: 6 },
      { key: 'tsh', value: 6.8, lo: 0.4, hi: 4.0, min: 0, max: 10 },
      { key: 'ft4', value: 0.9, lo: 0.8, hi: 1.8, min: 0.4, max: 2.4 },
      { key: 'hgb', value: 12.4, lo: 12.0, hi: 15.5, min: 8, max: 18 },
      { key: 'vitd', value: 31, lo: 20, hi: 50, min: 5, max: 70 },
    ],
    questions: [
      'My eGFR is 52. Has it been below 60 before, and should it be rechecked in three months?',
      'Should we test my urine for protein?',
      'Could any of my current medicines be affecting my kidneys?',
      'My TSH is high but free T4 is normal. What does that combination mean?',
      'Should the thyroid tests be repeated before deciding on anything?',
    ],
  },
]

export type Status = 'low' | 'in' | 'high'
export const statusOf = (r: Reading): Status =>
  r.lo !== undefined && r.value < r.lo ? 'low' : r.hi !== undefined && r.value > r.hi ? 'high' : 'in'

export const rangeText = (r: Reading) =>
  r.lo !== undefined && r.hi !== undefined ? `${r.lo}–${r.hi}` : r.lo !== undefined ? `≥ ${r.lo}` : `≤ ${r.hi}`

/** Show a value with as many decimals as its reference range uses (1.0, not 1). */
export const fmt = (r: Reading) => {
  const dp = Math.max(...[r.lo, r.hi, r.value].map((n) => (n === undefined ? 0 : (String(n).split('.')[1] ?? '').length)))
  return r.value.toFixed(dp)
}
