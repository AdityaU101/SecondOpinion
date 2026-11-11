export type System = 'Blood' | 'Iron & vitamins' | 'Blood sugar' | 'Cholesterol' | 'Kidneys' | 'Thyroid' | 'Liver'

export interface Biomarker {
  name: string
  abbr: string
  unit: string
  system: System
  /** One plain sentence: what the test measures. */
  what: string
  why: string
  low?: string
  high?: string
  /** Everyday foods linked to an off value. Fixed table, as in the real rule engine. */
  foods?: { when: 'low' | 'high'; items: string[]; note: string }
  source: string
}

export const biomarkers: Record<string, Biomarker> = {
  hgb: {
    name: 'Hemoglobin', abbr: 'HGB', unit: 'g/dL', system: 'Blood',
    what: 'The protein in red blood cells that carries oxygen around your body.',
    why: 'It is the main number used to check for anemia, which can cause tiredness and shortness of breath.',
    low: 'Often linked to low iron, low B12 or folate, or blood loss.',
    high: 'Can be seen with dehydration, smoking or living at altitude.',
    foods: { when: 'low', items: ['Lentils and beans', 'Spinach', 'Lean red meat', 'Fortified cereals'], note: 'Vitamin C alongside (citrus, peppers) helps your body absorb iron.' },
    source: 'WHO: Haemoglobin concentrations for the diagnosis of anaemia',
  },
  mcv: {
    name: 'Mean cell volume', abbr: 'MCV', unit: 'fL', system: 'Blood',
    what: 'The average size of your red blood cells.',
    why: 'Cell size helps point to the cause when hemoglobin is low.',
    low: 'Smaller cells are commonly seen with low iron.',
    high: 'Larger cells are commonly seen with low B12 or folate.',
    source: 'NIH MedlinePlus: MCV (Mean Corpuscular Volume)',
  },
  wbc: {
    name: 'White blood cells', abbr: 'WBC', unit: '×10³/µL', system: 'Blood',
    what: 'The cells of your immune system.',
    why: 'The count rises and falls with infection, inflammation and some medicines.',
    low: 'Can follow a viral illness or be related to certain medicines.',
    high: 'Often a sign your body is responding to infection or inflammation.',
    source: 'NIH MedlinePlus: White Blood Count (WBC)',
  },
  plt: {
    name: 'Platelets', abbr: 'PLT', unit: '×10³/µL', system: 'Blood',
    what: 'Cell fragments that help your blood clot.',
    why: 'Too few can mean easier bleeding; too many can affect clotting.',
    source: 'NIH MedlinePlus: Platelet Tests',
  },
  ferritin: {
    name: 'Ferritin', abbr: 'FERR', unit: 'ng/mL', system: 'Iron & vitamins',
    what: 'A protein that stores iron. It reflects how much iron you have in reserve.',
    why: 'Ferritin usually drops before hemoglobin does, so it is an early signal of low iron.',
    low: 'Your iron stores are running low.',
    high: 'Can rise with inflammation, liver conditions or iron overload.',
    foods: { when: 'low', items: ['Lentils and chickpeas', 'Tofu', 'Pumpkin seeds', 'Lean red meat'], note: 'Tea and coffee with meals reduce iron absorption.' },
    source: 'NIH MedlinePlus: Ferritin Blood Test',
  },
  vitd: {
    name: 'Vitamin D (25-OH)', abbr: 'VIT D', unit: 'ng/mL', system: 'Iron & vitamins',
    what: 'The storage form of vitamin D in your blood.',
    why: 'Vitamin D helps your body absorb calcium and keep bones strong.',
    low: 'Common with little sun exposure or low dietary intake.',
    foods: { when: 'low', items: ['Salmon and sardines', 'Fortified milk', 'Egg yolks', 'UV-exposed mushrooms'], note: 'Sensible sun exposure also raises vitamin D.' },
    source: 'NIH Office of Dietary Supplements: Vitamin D fact sheet',
  },
  tsh: {
    name: 'TSH', abbr: 'TSH', unit: 'mIU/L', system: 'Thyroid',
    what: 'The signal your brain sends to tell the thyroid how hard to work.',
    why: 'It is the first test used to check thyroid function.',
    low: 'Can mean the thyroid is overactive.',
    high: 'Can mean the thyroid is underactive and the brain is asking it to do more.',
    source: 'NIH MedlinePlus: TSH (Thyroid-stimulating hormone) Test',
  },
  ft4: {
    name: 'Free T4', abbr: 'FT4', unit: 'ng/dL', system: 'Thyroid',
    what: 'The main hormone your thyroid releases, in its active, unbound form.',
    why: 'Read together with TSH, it shows whether the thyroid is keeping up.',
    source: 'NIH MedlinePlus: Thyroxine (T4) Test',
  },
  glucose: {
    name: 'Fasting glucose', abbr: 'GLU', unit: 'mg/dL', system: 'Blood sugar',
    what: 'The amount of sugar in your blood after not eating overnight.',
    why: 'It is a snapshot of how your body is handling sugar right now.',
    high: 'Between 100 and 125 is the range described as pre-diabetes.',
    low: 'Can cause shakiness or sweating, especially on some diabetes medicines.',
    foods: { when: 'high', items: ['Whole grains', 'Beans and lentils', 'Non-starchy vegetables', 'Water instead of sugary drinks'], note: 'Regular activity also improves how your body uses sugar.' },
    source: 'ADA Standards of Care: Pre-Diabetes',
  },
  a1c: {
    name: 'HbA1c', abbr: 'A1C', unit: '%', system: 'Blood sugar',
    what: 'Your average blood sugar over roughly the past three months.',
    why: 'Unlike a single glucose reading, it is not thrown off by one meal or one day.',
    high: '5.7 to 6.4% is the pre-diabetes range; 6.5% or more on two tests is the diabetes range.',
    foods: { when: 'high', items: ['Oats and barley', 'Beans and lentils', 'Leafy greens', 'Nuts'], note: 'Changes show up in HbA1c slowly, over about three months.' },
    source: 'ADA Standards of Care: HbA1c Targets',
  },
  chol: {
    name: 'Total cholesterol', abbr: 'CHOL', unit: 'mg/dL', system: 'Cholesterol',
    what: 'All the cholesterol in your blood added together.',
    why: 'It gives an overall picture, but the LDL and HDL breakdown matters more.',
    high: 'Usually driven by LDL. Look at the breakdown below.',
    source: 'NIH MedlinePlus: Cholesterol Levels',
  },
  ldl: {
    name: 'LDL cholesterol', abbr: 'LDL', unit: 'mg/dL', system: 'Cholesterol',
    what: 'The cholesterol that can build up in artery walls.',
    why: 'Lower LDL is linked to lower risk of heart attack and stroke.',
    high: 'Under 100 is considered optimal; 160 and above is considered high.',
    foods: { when: 'high', items: ['Oats', 'Beans', 'Apples and citrus', 'Nuts', 'Olive oil in place of butter'], note: 'Soluble fibre binds cholesterol in the gut.' },
    source: 'NIH MedlinePlus: LDL Cholesterol Reference Ranges',
  },
  hdl: {
    name: 'HDL cholesterol', abbr: 'HDL', unit: 'mg/dL', system: 'Cholesterol',
    what: 'The cholesterol that carries excess cholesterol back to the liver.',
    why: 'For HDL, higher is generally better.',
    low: 'Linked to higher heart risk, especially alongside high triglycerides.',
    foods: { when: 'low', items: ['Oily fish', 'Olive oil', 'Nuts and seeds'], note: 'Regular exercise and not smoking raise HDL more than food does.' },
    source: 'NIH MedlinePlus: HDL, the "Good" Cholesterol',
  },
  tg: {
    name: 'Triglycerides', abbr: 'TRIG', unit: 'mg/dL', system: 'Cholesterol',
    what: 'The most common type of fat in your blood.',
    why: 'High levels add to heart risk and often travel with high blood sugar.',
    high: 'Often related to refined carbohydrates, alcohol or excess weight.',
    foods: { when: 'high', items: ['Oily fish twice a week', 'Whole grains instead of refined', 'Less alcohol', 'Fewer sugary drinks'], note: 'Triglycerides respond quickly to changes in diet.' },
    source: 'NIH MedlinePlus: Triglycerides',
  },
  alt: {
    name: 'ALT', abbr: 'ALT', unit: 'U/L', system: 'Liver',
    what: 'An enzyme found mostly in liver cells.',
    why: 'It leaks into the blood when liver cells are irritated or damaged.',
    high: 'Can rise with fatty liver, alcohol, some medicines or viral illness.',
    source: 'NIH MedlinePlus: ALT Blood Test',
  },
  creat: {
    name: 'Creatinine', abbr: 'CREAT', unit: 'mg/dL', system: 'Kidneys',
    what: 'A waste product from muscles that your kidneys filter out.',
    why: 'When the kidneys filter less well, creatinine builds up in the blood.',
    high: 'Can reflect reduced kidney filtering, dehydration or high muscle mass.',
    source: 'NIH MedlinePlus: Creatinine Test',
  },
  egfr: {
    name: 'eGFR', abbr: 'eGFR', unit: 'mL/min', system: 'Kidneys',
    what: 'An estimate of how much blood your kidneys filter each minute.',
    why: 'It is the standard way to describe kidney function.',
    low: 'Below 60 for three months or more is how chronic kidney disease is defined.',
    source: 'NIH NIDDK: Estimated Glomerular Filtration Rate (eGFR)',
  },
  bun: {
    name: 'Urea nitrogen', abbr: 'BUN', unit: 'mg/dL', system: 'Kidneys',
    what: 'A waste product from protein breakdown, cleared by the kidneys.',
    why: 'Read together with creatinine to judge kidney function and hydration.',
    high: 'Can rise with dehydration, a high-protein diet or reduced kidney filtering.',
    source: 'NIH MedlinePlus: BUN (Blood Urea Nitrogen)',
  },
  k: {
    name: 'Potassium', abbr: 'K', unit: 'mmol/L', system: 'Kidneys',
    what: 'A mineral that keeps nerves and the heartbeat steady.',
    why: 'The kidneys control potassium, so it is watched closely when kidney function changes.',
    source: 'NIH MedlinePlus: Potassium Blood Test',
  },
}
