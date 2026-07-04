"""
Rule-based anomaly detector — the deterministic layer of the pipeline.

Why rule-based AND LLM?
  LLMs are good at language — summarising, explaining, generating questions.
  They are NOT reliable for arithmetic or boundary checks. An LLM might say
  "your sodium looks fine" even when the extracted value is 158 mEq/L (high).

  This module does what rules do well: it extracts numeric lab values from
  the text using regex, looks them up against a reference table, and emits
  a structured Finding for each one. The LLM then uses these findings as
  grounded facts when writing the summary — it never has to judge numbers.

  This two-layer approach is what separates a production-quality system
  from a naive "just ask GPT-4" prototype.
"""
from __future__ import annotations
import re
import logging
from api.schemas import Finding, FindingStatus, Severity

log = logging.getLogger(__name__)


# ── REFERENCE RANGES ─────────────────────────────────────
# Source: NIH MedlinePlus + standard US adult lab reference ranges.
# Format: { "canonical_name": (low, high, unit, display_range, display_name) }
#
# Extending this is straightforward: add a row and a set of ALIASES below.

REF_TABLE: dict[str, tuple[float, float, str, str, str]] = {
    # Metabolic
    "glucose":          (70,   99,    "mg/dL",      "70–99 mg/dL",       "Fasting Glucose"),
    "bun":              (7,    20,    "mg/dL",      "7–20 mg/dL",         "BUN (Urea Nitrogen)"),
    "creatinine":       (0.6,  1.2,   "mg/dL",      "0.6–1.2 mg/dL",      "Creatinine"),
    "egfr":             (60,   9999,  "mL/min",     "> 60 mL/min/1.73m²", "eGFR"),
    "sodium":           (136,  145,   "mEq/L",      "136–145 mEq/L",      "Sodium"),
    "potassium":        (3.5,  5.0,   "mEq/L",      "3.5–5.0 mEq/L",      "Potassium"),
    "chloride":         (98,   107,   "mEq/L",      "98–107 mEq/L",       "Chloride"),
    "co2":              (22,   29,    "mEq/L",      "22–29 mEq/L",        "CO2 (Bicarbonate)"),
    "calcium":          (8.5,  10.5,  "mg/dL",      "8.5–10.5 mg/dL",     "Calcium"),
    "protein":          (6.0,  8.3,   "g/dL",       "6.0–8.3 g/dL",       "Total Protein"),
    "albumin":          (3.4,  5.4,   "g/dL",       "3.4–5.4 g/dL",       "Albumin"),
    "bilirubin":        (0.1,  1.2,   "mg/dL",      "0.1–1.2 mg/dL",      "Total Bilirubin"),
    "alt":              (7,    56,    "U/L",         "7–56 U/L",           "ALT (Liver)"),
    "ast":              (10,   40,    "U/L",         "10–40 U/L",          "AST (Liver)"),
    "alp":              (44,   147,   "U/L",         "44–147 U/L",         "Alkaline Phosphatase"),
    # Lipids
    "ldl":              (0,    99,    "mg/dL",      "< 100 mg/dL",        "LDL Cholesterol"),
    "hdl":              (40,   9999,  "mg/dL",      "> 40 mg/dL (M) / > 50 mg/dL (F)", "HDL Cholesterol"),
    "triglycerides":    (0,    149,   "mg/dL",      "< 150 mg/dL",        "Triglycerides"),
    "cholesterol":      (0,    199,   "mg/dL",      "< 200 mg/dL",        "Total Cholesterol"),
    # CBC
    "hemoglobin":       (13.5, 17.5,  "g/dL",       "13.5–17.5 g/dL (M)", "Hemoglobin"),
    "hematocrit":       (38.8, 50.0,  "%",           "38.8–50%",           "Hematocrit"),
    "wbc":              (4.5,  11.0,  "K/uL",       "4.5–11.0 K/µL",      "WBC (White Blood Cells)"),
    "platelets":        (150,  400,   "K/uL",       "150–400 K/µL",       "Platelets"),
    "rbc":              (4.7,  6.1,   "M/uL",       "4.7–6.1 M/µL",       "RBC (Red Blood Cells)"),
    # Thyroid
    "tsh":              (0.4,  4.0,   "mIU/L",      "0.4–4.0 mIU/L",      "TSH (Thyroid)"),
    "t4":               (4.5,  12.0,  "mcg/dL",     "4.5–12.0 mcg/dL",    "Free T4"),
    # Diabetes
    "hba1c":            (0,    5.6,   "%",           "< 5.7%",             "Hemoglobin A1c"),
    # Body composition
    "bmi":              (18.5, 24.9,  "kg/m²",      "18.5–24.9 kg/m²",    "BMI (Body Mass Index)"),
}

# Aliases map common abbreviations to canonical keys
ALIASES: dict[str, str] = {
    "fasting glucose": "glucose",
    "blood glucose": "glucose",
    "blood sugar": "glucose",
    "ldl-c": "ldl", "ldl cholesterol": "ldl",
    "hdl-c": "hdl", "hdl cholesterol": "hdl",
    "total cholesterol": "cholesterol",
    "creat": "creatinine",
    "egfr": "egfr", "gfr": "egfr",
    "wbc count": "wbc",
    "hgb": "hemoglobin", "hb": "hemoglobin",
    "hct": "hematocrit",
    "plt": "platelets",
    "a1c": "hba1c", "glycated hemoglobin": "hba1c",
    "trig": "triglycerides",
    "body mass index": "bmi",
}

# Regex: captures "LDL: 145 mg/dL" or "LDL   145" or "LDL = 145 mg/dL (H)"
_VALUE_RE = re.compile(
    r"(?P<name>[A-Za-z][A-Za-z0-9\s\-/()]+?)"
    r"[\s:=]+?"
    r"(?P<value>\d+\.?\d*)"
    r"\s*"
    r"(?P<unit>[A-Za-z/%µ][A-Za-z0-9/%µ.]*(?:/[A-Za-z0-9]+)?)?",
    re.IGNORECASE,
)

_EXPLANATIONS: dict[str, str] = {
    "glucose":     'Fasting blood glucose measures the sugar level in your blood after not eating. Values of 100–125 mg/dL are considered "pre-diabetic"; ≥ 126 mg/dL may indicate diabetes.',
    "ldl":         'LDL ("bad") cholesterol builds up in artery walls over time. Higher values increase cardiovascular risk. Lifestyle changes and medications can reduce it.',
    "hdl":         'HDL ("good") cholesterol helps remove LDL from the bloodstream. Higher is better. Low HDL increases cardiovascular risk.',
    "triglycerides":'Triglycerides are a type of fat in the blood. Elevated levels combined with high LDL or low HDL significantly increase heart disease risk.',
    "cholesterol":  'Total cholesterol reflects the sum of LDL, HDL, and other lipoproteins. Used as a quick screening metric.',
    "hba1c":        'A1c reflects your average blood sugar over the past 2–3 months. 5.7–6.4% is pre-diabetic; ≥ 6.5% may indicate diabetes.',
    "tsh":          'TSH is produced by the pituitary gland and tells the thyroid how much hormone to make. High TSH often means an underactive thyroid; low TSH can indicate overactivity.',
    "alt":          'ALT is an enzyme primarily found in the liver. Elevated levels may indicate liver stress or damage.',
    "ast":          'AST is found in the liver and muscles. Elevated levels can indicate liver disease or muscle injury.',
    "creatinine":   'Creatinine is a waste product filtered by the kidneys. High levels may suggest reduced kidney function.',
    "egfr":         'eGFR estimates how well your kidneys filter blood. Below 60 for more than 3 months suggests chronic kidney disease.',
    "hemoglobin":   'Hemoglobin carries oxygen in red blood cells. Low levels indicate anemia; high levels can indicate dehydration or other conditions.',
    "wbc":          'White blood cells are part of your immune system. Abnormal counts can indicate infection, inflammation, or blood disorders.',
    "platelets":    'Platelets help blood clot. Low counts can cause easy bruising or bleeding; high counts can increase clotting risk.',
    "bmi":          'Body Mass Index estimates body fat from height and weight. 18.5–24.9 is the healthy range; 25–29.9 is overweight and 30+ is obese. It is a screening tool, not a diagnosis — muscle mass and body type affect it.',
}

_DEFAULT_EXPLANATION = "This value was identified as outside the standard reference range. Ask your doctor what this means in the context of your full health picture."


# ── PUBLIC API ────────────────────────────────────────────

def detect_anomalies(text: str) -> list[Finding]:
    """
    Scan document text for lab values and flag those outside reference ranges.
    Returns a list of Finding objects (both normal and abnormal) for the LLM context.
    """
    findings: list[Finding] = []
    seen_params: set[str] = set()

    for match in _VALUE_RE.finditer(text):
        raw_name = match.group("name").strip().lower()
        raw_val  = match.group("value").strip()

        canonical = _resolve(raw_name)
        if not canonical or canonical in seen_params:
            continue

        try:
            numeric = float(raw_val)
        except ValueError:
            continue

        low, high, unit, ref_range, display_name = REF_TABLE[canonical]
        seen_params.add(canonical)

        # Determine status and severity
        if numeric > high:
            status   = FindingStatus.HIGH
            severity = _high_severity(canonical, numeric, high)
            value_str = f"{numeric} {unit} ↑"
        elif numeric < low:
            status   = FindingStatus.LOW
            severity = _low_severity(canonical, numeric, low)
            value_str = f"{numeric} {unit} ↓"
        else:
            status    = FindingStatus.NORMAL
            severity  = Severity.NORMAL
            value_str = f"{numeric} {unit}"

        explanation = _EXPLANATIONS.get(canonical, _DEFAULT_EXPLANATION)

        findings.append(Finding(
            parameter=display_name,
            value=value_str,
            reference_range=ref_range,
            status=status,
            severity=severity,
            explanation=explanation,
            numeric_value=numeric,
            ref_low=low,
            ref_high=high,
            unit=unit,
        ))

    # Sort: critical first, then by severity
    _severity_order = {Severity.CRITICAL: 0, Severity.MODERATE: 1, Severity.MILD: 2, Severity.NORMAL: 3}
    findings.sort(key=lambda f: _severity_order.get(f.severity, 9))

    log.info("Anomaly detection: %d findings (%d abnormal)",
             len(findings), sum(1 for f in findings if f.status != FindingStatus.NORMAL))
    return findings


# ── PRIVATE HELPERS ───────────────────────────────────────

def _resolve(raw_name: str) -> str | None:
    """Map a raw extracted name to a canonical REF_TABLE key."""
    cleaned = raw_name.strip().lower()
    if cleaned in REF_TABLE:
        return cleaned
    if cleaned in ALIASES:
        return ALIASES[cleaned]
    # Partial match on word boundary
    for alias, canonical in ALIASES.items():
        if alias in cleaned:
            return canonical
    for key in REF_TABLE:
        if key in cleaned:
            return key
    return None


def _high_severity(key: str, value: float, limit: float) -> Severity:
    """How far above the limit? Rough severity bucketing."""
    ratio = value / limit if limit > 0 else 1.0
    if ratio >= 2.0:   return Severity.CRITICAL
    if ratio >= 1.4:   return Severity.MODERATE
    return Severity.MILD


def _low_severity(key: str, value: float, limit: float) -> Severity:
    """How far below the limit?"""
    if limit == 0:     return Severity.MILD
    ratio = value / limit
    if ratio <= 0.5:   return Severity.CRITICAL
    if ratio <= 0.75:  return Severity.MODERATE
    return Severity.MILD
