/* ─────────────────────────────────────────────────────────
   ClearChart — frontend application logic
   Connects to FastAPI backend at /api/v1
   ───────────────────────────────────────────────────────── */

const API_BASE = 'http://localhost:8000/api/v1';

// ── STATE ─────────────────────────────────────────────────
let state = {
  activeTab: 'file',       // 'file' | 'text'
  selectedFile: null,
  textContent: '',
  currentJobId: null,
  pollInterval: null,
};

// ── TAB SWITCHING (upload tabs) ───────────────────────────
function switchTab(tab) {
  state.activeTab = tab;

  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
    t.setAttribute('aria-selected', t.dataset.tab === tab);
  });

  document.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.toggle('active', p.id === `panel-${tab}`);
  });

  refreshAnalyzeButton();
}

// ── FILE HANDLING ─────────────────────────────────────────
function onDragOver(e) {
  e.preventDefault();
  document.getElementById('dropzone').classList.add('dragover');
}

function onDragLeave(e) {
  document.getElementById('dropzone').classList.remove('dragover');
}

function onDrop(e) {
  e.preventDefault();
  document.getElementById('dropzone').classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) setFile(file);
}

function onFileSelected(e) {
  const file = e.target.files[0];
  if (file) setFile(file);
}

function setFile(file) {
  const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
  if (!allowed.includes(file.type)) {
    showToast('Please upload a PDF or image file (JPG, PNG)', 'error');
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    showToast('File is too large. Maximum size is 20 MB.', 'error');
    return;
  }

  state.selectedFile = file;

  document.getElementById('file-name').textContent = file.name;
  document.getElementById('file-size').textContent = formatFileSize(file.size);
  document.getElementById('file-preview').classList.remove('hidden');
  document.getElementById('dropzone').style.display = 'none';

  refreshAnalyzeButton();
}

function removeFile() {
  state.selectedFile = null;
  document.getElementById('file-preview').classList.add('hidden');
  document.getElementById('dropzone').style.display = '';
  document.getElementById('file-input').value = '';
  refreshAnalyzeButton();
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── TEXT HANDLING ─────────────────────────────────────────
function onTextInput() {
  const val = document.getElementById('text-input').value;
  state.textContent = val;
  document.getElementById('char-count').textContent = val.length.toLocaleString();
  refreshAnalyzeButton();
}

// ── ANALYZE BUTTON STATE ──────────────────────────────────
function refreshAnalyzeButton() {
  const btn = document.getElementById('analyze-btn');
  const hasFile = state.activeTab === 'file' && state.selectedFile !== null;
  const hasText = state.activeTab === 'text' && state.textContent.trim().length > 50;
  btn.disabled = !(hasFile || hasText);
}

// ── ANALYSIS FLOW ─────────────────────────────────────────
async function startAnalysis() {
  showView('processing-view');
  resetProcessingUI();

  try {
    let jobId;

    if (state.activeTab === 'file' && state.selectedFile) {
      jobId = await uploadFile(state.selectedFile);
    } else {
      jobId = await submitText(state.textContent);
    }

    state.currentJobId = jobId;
    pollJobStatus(jobId);

  } catch (err) {
    console.error('Analysis failed:', err);
    showError(err.message || 'Something went wrong. Please try again.');
  }
}

async function uploadFile(file) {
  updateStep('parse', 'active');
  updateProgress(10);

  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch(`${API_BASE}/analyze/upload`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Upload failed (${res.status})`);
  }

  const data = await res.json();
  return data.job_id;
}

async function submitText(text) {
  updateStep('parse', 'active');
  updateProgress(10);

  const res = await fetch(`${API_BASE}/analyze/text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Submission failed (${res.status})`);
  }

  const data = await res.json();
  return data.job_id;
}

// ── JOB POLLING ───────────────────────────────────────────
function pollJobStatus(jobId) {
  let attempts = 0;
  let finished = false;               // ensures the result renders exactly once
  const MAX_ATTEMPTS = 120;           // 2 minutes at 1s intervals

  if (state.pollInterval) clearInterval(state.pollInterval);  // no leftover loop

  const stop = () => {
    finished = true;
    clearInterval(state.pollInterval);
    state.pollInterval = null;
  };

  state.pollInterval = setInterval(async () => {
    if (finished) return;             // a previous tick already handled completion
    attempts++;
    if (attempts > MAX_ATTEMPTS) {
      stop();
      showError('Analysis is taking too long. Please try again.');
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/jobs/${jobId}`);
      if (!res.ok) throw new Error('Status check failed');

      const job = await res.json();
      if (finished) return;           // completed while THIS tick was awaiting — bail out

      syncProcessingUI(job);

      if (job.status === 'completed' && job.result) {
        stop();
        showResults(job.result);
      } else if (job.status === 'failed') {
        stop();
        showError(job.error || 'Analysis failed. Please try again.');
      }
    } catch (err) {
      console.warn('Poll error:', err);
    }
  }, 1000);
}

// ── PROCESSING UI ─────────────────────────────────────────
function resetProcessingUI() {
  updateProgress(0);
  ['parse','chunk','retrieve','analyze','report'].forEach(s => {
    const el = document.getElementById(`step-${s}`);
    el.className = 'step-item';
  });
}

function syncProcessingUI(job) {
  const p = job.progress || 0;
  updateProgress(p);

  // Map progress ranges to active step
  const stepEl = document.getElementById('processing-step');
  if (p < 20)  { setActiveStep('parse');    stepEl.textContent = 'Parsing document…';               }
  else if (p < 40) { setActiveStep('chunk');    stepEl.textContent = 'Chunking & embedding…';           }
  else if (p < 60) { setActiveStep('retrieve'); stepEl.textContent = 'Retrieving clinical guidelines…'; }
  else if (p < 80) { setActiveStep('analyze');  stepEl.textContent = 'Running AI analysis…';            }
  else             { setActiveStep('report');   stepEl.textContent = 'Generating your report…';         }
}

function setActiveStep(active) {
  const order = ['parse','chunk','retrieve','analyze','report'];
  const activeIdx = order.indexOf(active);
  order.forEach((s, i) => {
    const el = document.getElementById(`step-${s}`);
    if (i < activeIdx)      el.className = 'step-item done';
    else if (i === activeIdx) el.className = 'step-item active';
    else                     el.className = 'step-item';
  });
}

function updateStep(id, cls) {
  const el = document.getElementById(`step-${id}`);
  if (el) el.className = `step-item ${cls}`;
}

function updateProgress(pct) {
  const bar = document.getElementById('progress-bar');
  const wrap = document.getElementById('progress-bar-wrap');
  bar.style.width = `${pct}%`;
  wrap.setAttribute('aria-valuenow', pct);
}

// ── RENDER RESULTS ────────────────────────────────────────
function showResults(report) {
  showView('results-view');

  // Urgency banner
  const banner = document.getElementById('urgency-banner');
  banner.className = `urgency-banner ${report.urgency}`;
  document.getElementById('urgency-dot').className = 'urgency-dot';
  const urgencyMessages = {
    urgent:  '⚠ Some findings may need prompt medical attention. Please contact your doctor soon.',
    watch:   '⚡ A few findings are worth discussing at your next appointment.',
    routine: '✓ Everything looks within normal ranges. No immediate concerns detected.',
  };
  document.getElementById('urgency-label').textContent = urgencyMessages[report.urgency] || '';

  // Summary
  document.getElementById('summary-text').textContent = report.summary;
  if (report.patient_context) {
    document.getElementById('context-card').style.display = '';
    document.getElementById('context-text').textContent = report.patient_context;
  } else {
    document.getElementById('context-card').style.display = 'none';
  }

  // Visual health snapshot (Groq-scored)
  renderHealthSnapshot(report.health_snapshot || []);

  // Findings
  const findingsList = document.getElementById('findings-list');
  findingsList.innerHTML = '';
  document.getElementById('finding-badge').textContent = report.findings.length;

  if (report.findings.length === 0) {
    findingsList.innerHTML = `<div class="summary-card"><p class="summary-text" style="color:var(--gray-400)">No abnormal findings detected.</p></div>`;
  } else {
    report.findings.forEach(f => {
      findingsList.appendChild(buildFindingCard(f));
    });
  }

  // Questions
  const qList = document.getElementById('questions-list');
  qList.innerHTML = '';
  (report.questions_for_doctor || []).forEach((q, i) => {
    const li = document.createElement('li');
    li.className = 'question-item';
    li.innerHTML = `
      <div class="q-num">${i + 1}</div>
      <div class="q-body">
        <p class="q-text">${escapeHtml(q.question)}</p>
        ${q.context ? `<p class="q-context">${escapeHtml(q.context)}</p>` : ''}
      </div>`;
    qList.appendChild(li);
  });

  // Citations
  const citList = document.getElementById('citations-list');
  citList.innerHTML = '';
  (report.citations || []).forEach(c => {
    const div = document.createElement('div');
    div.className = 'citation-item';
    div.innerHTML = `
      <p class="citation-source">${escapeHtml(c.source)}</p>
      <p class="citation-passage">"${escapeHtml(c.passage)}"</p>
      ${c.url ? `<a href="${c.url}" target="_blank" rel="noopener noreferrer" class="citation-url">${c.url}</a>` : ''}`;
    citList.appendChild(div);
  });

  // Disclaimer
  if (report.disclaimer) {
    document.getElementById('disclaimer-text').textContent = report.disclaimer;
  }
}

function buildFindingCard(f) {
  const card = document.createElement('div');
  card.className = `finding-card ${f.severity}`;

  const statusClass = {
    high: 'chip-high', low: 'chip-low', abnormal: 'chip-abnormal', normal: 'chip-normal',
  }[f.status] || 'chip-abnormal';

  const valueColor = {
    high: 'var(--red)', low: '#2563EB', abnormal: 'var(--amber)', normal: 'var(--green)',
  }[f.status] || 'var(--gray-800)';

  card.innerHTML = `
    <div class="finding-header">
      <span class="finding-param">${escapeHtml(f.parameter)}</span>
      <div class="finding-meta">
        <span class="finding-value" style="color:${valueColor}">${escapeHtml(f.value)}</span>
        <span class="status-chip ${statusClass}">${f.status.toUpperCase()}</span>
        ${f.reference_range ? `<span class="finding-ref">Ref: ${escapeHtml(f.reference_range)}</span>` : ''}
      </div>
    </div>
    ${renderComparisonBar(f)}
    <p class="finding-explanation">${escapeHtml(f.explanation)}</p>`;
  return card;
}

/* Build a horizontal "healthy range vs your value" chart for one finding.
   Uses numeric_value / ref_low / ref_high. ref_high >= 9000 means "no upper
   limit" (e.g. eGFR > 60); ref_low 0 means "no meaningful lower limit". */
function renderComparisonBar(f) {
  const v = f.numeric_value;
  if (v === null || v === undefined) return '';           // no numeric data → skip chart

  const openUpper = f.ref_high === null || f.ref_high === undefined || f.ref_high >= 9000;
  const lowRef  = (f.ref_low  === null || f.ref_low  === undefined) ? 0 : f.ref_low;
  const highRef = openUpper ? Math.max(v, lowRef) * 1.5 : f.ref_high;

  // Axis bounds with padding so nothing sits on the very edge.
  let axisMin = Math.min(lowRef, v);
  let axisMax = Math.max(highRef, v);
  const span = (axisMax - axisMin) || Math.max(v, 1);
  const pad = span * 0.18;
  axisMin = Math.max(0, axisMin - pad);
  axisMax = axisMax + pad;

  const pos = (x) => {
    const p = ((x - axisMin) / (axisMax - axisMin)) * 100;
    return Math.max(0, Math.min(100, p));
  };

  const bandLeft  = pos(lowRef);
  const bandRight = openUpper ? 100 : pos(highRef);
  const bandWidth = Math.max(2, bandRight - bandLeft);
  const markerPos = pos(v);

  const markerColor = f.status === 'normal' ? 'var(--green)' : (f.status === 'low' ? '#2563EB' : 'var(--red)');
  const unit = f.unit ? ' ' + escapeHtml(f.unit) : '';
  const healthyText = openUpper
    ? `≥ ${fmt(lowRef)}${unit}`
    : (lowRef <= 0 ? `≤ ${fmt(highRef)}${unit}` : `${fmt(lowRef)}–${fmt(highRef)}${unit}`);

  return `
    <div class="cmp">
      <div class="cmp-track">
        <div class="cmp-band" style="left:${bandLeft}%; width:${bandWidth}%"></div>
        <div class="cmp-marker" style="left:${markerPos}%; background:${markerColor}"></div>
        <div class="cmp-value-label" style="left:${markerPos}%; color:${markerColor}">${fmt(v)}</div>
      </div>
      <div class="cmp-legend">
        <span class="cmp-key"><span class="cmp-swatch cmp-swatch-band"></span>Healthy: ${healthyText}</span>
        <span class="cmp-key"><span class="cmp-swatch" style="background:${markerColor}"></span>You: ${fmt(v)}${unit}</span>
      </div>
    </div>`;
}

function fmt(n) {
  if (n === null || n === undefined) return '';
  return Number.isInteger(n) ? String(n) : (Math.round(n * 10) / 10).toString();
}

// ── RESULT TABS ───────────────────────────────────────────
function switchResultTab(tab) {
  document.querySelectorAll('.result-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.rtab === tab);
  });
  document.querySelectorAll('.result-panel').forEach(p => {
    p.classList.toggle('active', p.id === `rtab-${tab}`);
  });
}

// ── EXPORT ────────────────────────────────────────────────
function exportPDF() {
  if (!state.currentJobId) return;
  window.open(`${API_BASE}/jobs/${state.currentJobId}/export`, '_blank');
}

// ── START OVER ────────────────────────────────────────────
function startOver() {
  if (state.pollInterval) clearInterval(state.pollInterval);

  state.selectedFile = null;
  state.textContent = '';
  state.currentJobId = null;

  document.getElementById('file-preview').classList.add('hidden');
  document.getElementById('dropzone').style.display = '';
  document.getElementById('file-input').value = '';
  document.getElementById('text-input').value = '';
  document.getElementById('char-count').textContent = '0';
  switchTab('file');
  refreshAnalyzeButton();
  showView('upload-view');
}

// ── VISUAL HEALTH SNAPSHOT ────────────────────────────────
function renderHealthSnapshot(domains) {
  const card = document.getElementById('snapshot-card');
  const grid = document.getElementById('snapshot-grid');
  if (!domains || domains.length === 0) { card.style.display = 'none'; return; }
  card.style.display = '';

  const overall = Math.round(domains.reduce((s, d) => s + (d.score || 0), 0) / domains.length);
  const ringColor = overall >= 80 ? 'var(--green)' : overall >= 55 ? 'var(--amber)' : 'var(--red)';
  const ring = document.getElementById('wellness-ring');
  ring.style.setProperty('--ring-color', ringColor);

  grid.innerHTML = '';
  domains.forEach((d, i) => {
    const color = d.status === 'good' ? 'var(--green)' : d.status === 'watch' ? 'var(--amber)' : 'var(--red)';
    const el = document.createElement('div');
    el.className = 'hbar';
    el.style.animationDelay = (i * 80) + 'ms';
    el.innerHTML = `
      <div class="hbar-top">
        <span class="hbar-area">${escapeHtml(d.area)}</span>
        <span class="hbar-score" style="color:${color}">${d.score}</span>
      </div>
      <div class="hbar-track"><div class="hbar-fill" style="--w:${d.score}%; background:${color}"></div></div>
      ${d.note ? `<p class="hbar-note">${escapeHtml(d.note)}</p>` : ''}`;
    grid.appendChild(el);
  });

  const scoreEl = document.getElementById('wellness-score');
  if (prefersReducedMotion()) {
    ring.style.setProperty('--p', overall);
    scoreEl.textContent = overall;
  } else {
    requestAnimationFrame(() => ring.style.setProperty('--p', overall));
    animateCount(scoreEl, overall, 1100);
  }
}

function animateCount(el, target, duration) {
  const start = performance.now();
  function tick(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = Math.round(eased * target);
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function goToBmi(e) {
  if (e) e.preventDefault();
  showView('upload-view');
  setTimeout(() => {
    const card = document.getElementById('bmi-card');
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.remove('flash');
    void card.offsetWidth;   // reflow so the animation can replay
    card.classList.add('flash');
  }, 80);
}

// ── BMI CALCULATOR ────────────────────────────────────────
let bmiUnits = 'metric';   // 'metric' (cm, kg) | 'imperial' (in, lb)
let _lastBmi = null;

function toggleBmiUnits(units) {
  bmiUnits = units;
  document.querySelectorAll('.bmi-unit-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.units === units));
  document.getElementById('bmi-height-unit').textContent = units === 'metric' ? 'cm' : 'in';
  document.getElementById('bmi-weight-unit').textContent = units === 'metric' ? 'kg' : 'lb';
  computeBMI();
}

function computeBMI() {
  const h = parseFloat(document.getElementById('bmi-height').value);
  const w = parseFloat(document.getElementById('bmi-weight').value);
  const resultEl = document.getElementById('bmi-result');

  if (!h || !w || h <= 0 || w <= 0) { resultEl.classList.add('hidden'); _lastBmi = null; return; }

  let bmi;
  if (bmiUnits === 'metric') {
    const m = h / 100;
    bmi = w / (m * m);
  } else {
    bmi = (w / (h * h)) * 703;   // imperial formula
  }
  bmi = Math.round(bmi * 10) / 10;

  let category, status;
  if (bmi < 18.5)      { category = 'Underweight';    status = 'low';    }
  else if (bmi < 25)   { category = 'Healthy weight'; status = 'normal'; }
  else if (bmi < 30)   { category = 'Overweight';     status = 'high';   }
  else                 { category = 'Obese';          status = 'high';   }

  _lastBmi = bmi;
  const catColor = status === 'normal' ? 'var(--green)' : 'var(--red)';

  document.getElementById('bmi-value').textContent = bmi;
  document.getElementById('bmi-value').style.color = catColor;
  document.getElementById('bmi-category').textContent = category;
  document.getElementById('bmi-category').style.color = catColor;
  document.getElementById('bmi-bar').innerHTML =
    renderComparisonBar({ numeric_value: bmi, ref_low: 18.5, ref_high: 24.9, unit: 'kg/m²', status });
  resultEl.classList.remove('hidden');
}

function addBmiToReport() {
  if (!_lastBmi) { showToast('Enter your height and weight first', 'error'); return; }
  switchTab('text');
  const ta = document.getElementById('text-input');
  const line = `BMI: ${_lastBmi} kg/m2 — Body Mass Index calculated from height and weight.`;
  ta.value = (ta.value.trim() ? ta.value.trim() + '\n' : '') + line + '\n';
  onTextInput();
  showToast('BMI added to the text box. Add your other lab values, then Analyze.', 'info');
  ta.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ── VIEW TRANSITIONS ──────────────────────────────────────
function showView(viewId) {
  document.querySelectorAll('.view').forEach(v => {
    v.classList.toggle('active', v.id === viewId);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── ERROR HANDLING ────────────────────────────────────────
function showError(message) {
  startOver();
  showToast(message, 'error');
}

// ── TOAST NOTIFICATIONS ───────────────────────────────────
function showToast(message, type = 'info') {
  const existing = document.getElementById('toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'toast';
  toast.style.cssText = `
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    background: ${type === 'error' ? '#3B1213' : '#0A2E2B'};
    border: 1px solid ${type === 'error' ? 'rgba(220,38,38,0.5)' : 'rgba(45,212,191,0.4)'};
    color: ${type === 'error' ? '#FECACA' : '#D5F0E9'};
    padding: 13px 22px; border-radius: 12px;
    font-size: 14px; font-weight: 500; z-index: 9999;
    box-shadow: 0 12px 32px -8px rgba(10,46,43,0.5);
    animation: slideUp 0.25s cubic-bezier(.22,.9,.24,1); max-width: 400px; text-align: center;
  `;
  toast.textContent = message;

  const style = document.createElement('style');
  style.textContent = `@keyframes slideUp { from { opacity:0; transform:translateX(-50%) translateY(12px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }`;
  document.head.appendChild(style);

  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ── MOCK MODE (when backend not running) ──────────────────
// Intercepts API calls and returns sample data so you can
// see the full UI without the backend running.
const MOCK_MODE = false; // real backend (Groq + Neon) is running

if (MOCK_MODE) {
  const _originalFetch = window.fetch;
  window.fetch = async (url, opts) => {
    if (!url.startsWith(API_BASE)) return _originalFetch(url, opts);

    await sleep(600 + Math.random() * 400);

    if (url.includes('/analyze/')) {
      return mockResponse({ job_id: 'mock-job-001', status: 'pending', message: 'Analysis started' });
    }

    if (url.includes('/jobs/mock-job-001/export')) {
      return _originalFetch(url, opts); // let through
    }

    if (url.includes('/jobs/mock-job-001')) {
      const progress = mockProgressTick();
      if (progress < 100) {
        return mockResponse({ job_id: 'mock-job-001', status: 'processing', progress, result: null, error: null });
      }
      return mockResponse({ job_id: 'mock-job-001', status: 'completed', progress: 100, result: MOCK_REPORT, error: null });
    }

    return _originalFetch(url, opts);
  };
}

let _mockProgress = 0;
function mockProgressTick() {
  _mockProgress = Math.min(100, _mockProgress + 12 + Math.random() * 8);
  return Math.floor(_mockProgress);
}

function mockResponse(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const MOCK_REPORT = {
  urgency: 'watch',
  summary: 'Your blood panel from June 2026 shows a few values outside the normal range. Your LDL cholesterol is elevated at 145 mg/dL (normal is under 100 mg/dL for adults), and your fasting glucose of 108 mg/dL is in the pre-diabetic range. Your kidney function markers (creatinine and eGFR) are within normal limits, and your complete blood count looks healthy overall. These are findings worth discussing with your doctor at your next scheduled appointment.',
  patient_context: 'Comprehensive metabolic panel and lipid panel results detected. Two values — LDL cholesterol and fasting glucose — were identified as outside reference ranges and cross-referenced against USPSTF and NIH clinical guidelines.',
  findings: [
    {
      parameter: 'LDL Cholesterol',
      value: '145 mg/dL',
      reference_range: '< 100 mg/dL',
      status: 'high',
      severity: 'moderate',
      explanation: 'Your LDL ("bad") cholesterol is 45% above the recommended limit. Elevated LDL increases the risk of plaque buildup in arteries over time. Lifestyle changes (diet, exercise) and in some cases medication are used to bring this down.',
    },
    {
      parameter: 'Fasting Glucose',
      value: '108 mg/dL',
      reference_range: '70–99 mg/dL',
      status: 'high',
      severity: 'mild',
      explanation: 'A fasting glucose of 100–125 mg/dL is classified as "pre-diabetes" by the ADA. This doesn\'t mean you have diabetes, but it indicates your body is having some difficulty regulating blood sugar. Diet adjustments and exercise can often reverse this stage.',
    },
    {
      parameter: 'Hemoglobin A1c',
      value: '5.4%',
      reference_range: '< 5.7%',
      status: 'normal',
      severity: 'normal',
      explanation: 'Your 3-month average blood sugar is normal. This is reassuring alongside the slightly elevated fasting glucose.',
    },
    {
      parameter: 'eGFR (Kidney Function)',
      value: '88 mL/min/1.73m²',
      reference_range: '> 60 mL/min/1.73m²',
      status: 'normal',
      severity: 'normal',
      explanation: 'Your kidney filtration rate is in the normal range, indicating healthy kidney function.',
    },
  ],
  questions_for_doctor: [
    {
      question: 'My LDL is 145 mg/dL — should I consider a statin medication, or can lifestyle changes alone bring it down?',
      context: 'Based on your elevated LDL finding and USPSTF statin guidelines for preventive cardiovascular care.',
    },
    {
      question: 'My fasting glucose of 108 mg/dL puts me in the pre-diabetic range. What specific dietary changes would you recommend, and should I be monitoring my blood sugar at home?',
      context: 'Based on your fasting glucose finding and ADA pre-diabetes management guidelines.',
    },
    {
      question: 'Given both my LDL and fasting glucose are slightly elevated, should I be screened for metabolic syndrome?',
      context: 'Metabolic syndrome is a cluster of conditions (high blood sugar, high cholesterol, elevated blood pressure) that together increase cardiovascular risk.',
    },
    {
      question: 'How soon should I repeat these tests to track whether lifestyle changes are having an effect?',
      context: 'For monitoring pre-diabetes and elevated LDL, typical follow-up intervals range from 3 to 6 months.',
    },
  ],
  citations: [
    {
      source: 'USPSTF — Statin Use for the Primary Prevention of CVD',
      passage: 'The USPSTF recommends prescribing a statin for adults aged 40–75 who have one or more CVD risk factors and an estimated 10-year CVD event risk of 10% or greater.',
      url: 'https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/statin-use-in-adults-preventive-medication',
    },
    {
      source: 'ADA Standards of Medical Care — Pre-Diabetes',
      passage: 'Fasting plasma glucose 100–125 mg/dL is classified as impaired fasting glucose (pre-diabetes). Referral to an intensive behavioral lifestyle intervention program is recommended.',
      url: 'https://diabetesjournals.org/care/issue/47/Supplement_1',
    },
    {
      source: 'NIH MedlinePlus — LDL Reference Ranges',
      passage: 'An LDL level of less than 100 mg/dL is considered optimal. 130–159 mg/dL is borderline high. Dietary modification is the first-line recommendation.',
      url: 'https://medlineplus.gov/cholesterollevelswhatyouneedtoknow.html',
    },
  ],
  disclaimer: 'This report is for health literacy purposes only. It is not a medical diagnosis, clinical opinion, or professional advice. Always consult a qualified, licensed healthcare professional before making any decisions about your health.',
  confidence_score: 0.87,
};

// ── UTILITY ───────────────────────────────────────────────
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
