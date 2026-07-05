/* ─────────────────────────────────────────────────────────
   ClearChart — frontend application logic
   Connects to FastAPI backend at /api/v1
   ───────────────────────────────────────────────────────── */

const API_BASE = 'http://localhost:8000/api/v1';

// ── AUTH GUARD ────────────────────────────────────────────
// app.html is only for signed-in (or guest) sessions.
const session = ccGetSession();
if (!session) {
  window.location.replace('login.html');
} else {
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('chip-avatar').textContent = ccInitials(session.name);
    document.getElementById('chip-name').textContent = session.name;
    const greeting = document.getElementById('app-greeting');
    if (greeting && session.name && !session.guest) {
      const first = session.name.trim().split(/\s+/)[0];
      greeting.textContent = `Let's read your records, ${first}`;
    }
  });
}

// ── STATE ─────────────────────────────────────────────────
let state = {
  activeTab: 'file',       // 'file' | 'text'
  selectedFile: null,
  textContent: '',
  currentJobId: null,
  pollInterval: null,
  lastReport: null,        // completed report — powers chat context + nutrition
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
    headers: authHeaders(),
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
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
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
        recordHistory(jobId, job.result);
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
  state.lastReport = report;
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

  // Nutrition guidance derived from the findings
  renderNutrition(report.findings || []);

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

// ── AUTH HEADER HELPER ────────────────────────────────────
function authHeaders() {
  return session && session.token ? { Authorization: `Bearer ${session.token}` } : {};
}

// ── REPORT HISTORY ────────────────────────────────────────
// Signed-in users: history lives server-side (jobs.user_id → /reports).
// Guests: a device-local copy in localStorage, capped at 20 entries.

const LOCAL_HISTORY_KEY = 'clearchart-history';

function recordHistory(jobId, report) {
  if (session && session.token) return;   // server already owns it
  try {
    const entries = JSON.parse(localStorage.getItem(LOCAL_HISTORY_KEY) || '[]');
    entries.unshift({ job_id: jobId, created_at: new Date().toISOString(), report });
    localStorage.setItem(LOCAL_HISTORY_KEY, JSON.stringify(entries.slice(0, 20)));
  } catch (e) { console.warn('Could not save local history:', e); }
}

async function loadHistoryEntries() {
  if (session && session.token) {
    const res = await fetch(`${API_BASE}/reports`, { headers: authHeaders() });
    if (!res.ok) throw new Error('Could not load your reports.');
    const data = await res.json();
    return (data.reports || []).map(r => ({
      job_id: r.job_id,
      created_at: r.created_at,
      urgency: r.urgency,
      summary: r.summary,
      findings: r.findings || [],
      report: null,                        // fetched on open via /jobs/{id}
    }));
  }
  // Guest: local entries carry the full report
  const entries = JSON.parse(localStorage.getItem(LOCAL_HISTORY_KEY) || '[]');
  return entries.map(e => ({
    job_id: e.job_id,
    created_at: e.created_at,
    urgency: e.report?.urgency,
    summary: e.report?.summary || '',
    findings: e.report?.findings || [],
    report: e.report,
  }));
}

async function showHistory(e) {
  if (e) e.preventDefault();
  showView('history-view');

  const list = document.getElementById('history-list');
  const empty = document.getElementById('history-empty');
  const trendsCard = document.getElementById('trends-card');
  list.innerHTML = '<div class="nutri-empty">Loading your reports…</div>';
  empty.style.display = 'none';
  trendsCard.style.display = 'none';

  let entries = [];
  try {
    entries = await loadHistoryEntries();
  } catch (err) {
    list.innerHTML = '';
    empty.textContent = err.message || 'Could not load your reports.';
    empty.style.display = '';
    return;
  }

  list.innerHTML = '';
  if (entries.length === 0) {
    empty.style.display = '';
    return;
  }

  renderTrends(entries);
  entries.forEach((entry, i) => {
    list.appendChild(buildHistoryCard(entry, i));
  });
}

function formatReportDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
    + ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function buildHistoryCard(entry, index) {
  const div = document.createElement('div');
  div.className = 'history-card';
  div.style.animationDelay = `${Math.min(index * 0.06, 0.4)}s`;

  const urgency = entry.urgency || 'routine';
  const urgencyText = { urgent: 'Needs attention', watch: 'Worth discussing', routine: 'All routine' }[urgency] || '';
  const abnormal = (entry.findings || []).filter(f => (f.status || '').toLowerCase() !== 'normal').length;

  div.innerHTML = `
    <div class="history-top">
      <span class="history-date">${escapeHtml(formatReportDate(entry.created_at))}</span>
      <span class="history-urgency ${urgency}">${urgencyText}</span>
    </div>
    <p class="history-summary">${escapeHtml((entry.summary || '').slice(0, 180))}${(entry.summary || '').length > 180 ? '…' : ''}</p>
    <div class="history-foot">
      <span class="history-count">${entry.findings.length} values · ${abnormal} flagged</span>
      <button class="btn-outline-sm">Open report
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
      </button>
    </div>`;

  div.querySelector('button').addEventListener('click', () => openHistoryReport(entry));
  return div;
}

async function openHistoryReport(entry) {
  state.currentJobId = entry.job_id;
  if (entry.report) {
    showResults(entry.report);
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/jobs/${entry.job_id}`);
    if (!res.ok) throw new Error();
    const job = await res.json();
    if (job.result) { showResults(job.result); return; }
    throw new Error();
  } catch {
    showToast('Could not open that report. It may have been cleaned up on the server.', 'error');
  }
}

// ── TRENDS (per-parameter sparklines) ─────────────────────
// Small multiples: one sparkline per lab value that appears in ≥2 reports.
// Single series each → brand teal line, healthy-range band, no legend needed.

function normalizeParam(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function renderTrends(entries) {
  const card = document.getElementById('trends-card');
  const grid = document.getElementById('trends-grid');

  // Group numeric findings by parameter across reports (oldest → newest)
  const byParam = new Map();
  [...entries].reverse().forEach(entry => {
    (entry.findings || []).forEach(f => {
      if (f.numeric_value === null || f.numeric_value === undefined) return;
      const key = normalizeParam(f.parameter);
      if (!key) return;
      if (!byParam.has(key)) byParam.set(key, { name: f.parameter, unit: f.unit, points: [] });
      byParam.get(key).points.push({
        date: entry.created_at,
        value: f.numeric_value,
        status: f.status,
        ref_low: f.ref_low,
        ref_high: f.ref_high,
      });
    });
  });

  const series = [...byParam.values()].filter(s => s.points.length >= 2).slice(0, 8);
  if (series.length === 0) { card.style.display = 'none'; return; }

  card.style.display = '';
  grid.innerHTML = '';
  series.forEach((s, i) => grid.appendChild(buildTrendCard(s, i)));
}

function buildTrendCard(series, index) {
  const div = document.createElement('div');
  div.className = 'trend-card';
  div.style.animationDelay = `${index * 0.07}s`;

  const pts = series.points;
  const latest = pts[pts.length - 1];
  const previous = pts[pts.length - 2];
  const delta = latest.value - previous.value;
  const deltaText = delta === 0 ? 'no change'
    : `${delta > 0 ? '▲' : '▼'} ${fmt(Math.abs(delta))} since last report`;
  const latestStatus = (latest.status || '').toLowerCase();
  const statusClass = { high: 'chip-high', low: 'chip-low', abnormal: 'chip-abnormal', normal: 'chip-normal' }[latestStatus] || 'chip-normal';

  div.innerHTML = `
    <div class="trend-top">
      <span class="trend-name">${escapeHtml(series.name)}</span>
      <span class="status-chip ${statusClass}">${escapeHtml((latest.status || '').toUpperCase())}</span>
    </div>
    <div class="trend-readout">
      <span class="trend-value">${fmt(latest.value)}${series.unit ? ' ' + escapeHtml(series.unit) : ''}</span>
      <span class="trend-delta">${escapeHtml(deltaText)}</span>
    </div>
    ${buildSparklineSVG(pts)}
    <div class="trend-dates">
      <span>${escapeHtml(shortDate(pts[0].date))}</span>
      <span>${escapeHtml(shortDate(latest.date))}</span>
    </div>`;
  return div;
}

function shortDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function buildSparklineSVG(pts) {
  const W = 260, H = 64, PAD = 8;

  // y-domain: values plus the healthy band, padded so nothing kisses the edge
  const refLow = pts.find(p => p.ref_low !== null && p.ref_low !== undefined)?.ref_low;
  const refHigh = pts.find(p => p.ref_high !== null && p.ref_high !== undefined && p.ref_high < 9000)?.ref_high;
  const values = pts.map(p => p.value);
  let lo = Math.min(...values, refLow ?? Infinity);
  let hi = Math.max(...values, refHigh ?? -Infinity);
  if (!isFinite(lo)) lo = Math.min(...values);
  if (!isFinite(hi)) hi = Math.max(...values);
  const span = (hi - lo) || Math.abs(hi) || 1;
  lo -= span * 0.15; hi += span * 0.15;

  const x = i => PAD + (i / Math.max(pts.length - 1, 1)) * (W - PAD * 2);
  const y = v => H - PAD - ((v - lo) / (hi - lo)) * (H - PAD * 2);

  // Healthy-range band (neutral green tint, behind the line)
  let band = '';
  if (refLow !== undefined || refHigh !== undefined) {
    const top = y(refHigh !== undefined ? refHigh : hi);
    const bottom = y(refLow !== undefined ? refLow : lo);
    band = `<rect x="${PAD}" y="${top.toFixed(1)}" width="${W - PAD * 2}" height="${Math.max(bottom - top, 2).toFixed(1)}" rx="2" class="spark-band"/>`;
  }

  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');

  // Points: small dots, larger invisible hit targets with native tooltips
  const dots = pts.map((p, i) => {
    const isLast = i === pts.length - 1;
    return `
      <circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="${isLast ? 4 : 2.5}" class="spark-dot${isLast ? ' last' : ''}"/>
      <circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="10" fill="transparent">
        <title>${escapeHtml(shortDate(p.date))}: ${fmt(p.value)}</title>
      </circle>`;
  }).join('');

  return `
    <svg class="sparkline" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Trend chart">
      ${band}
      <path d="${path}" class="spark-line"/>
      ${dots}
    </svg>`;
}

// ── APPOINTMENT PREP ──────────────────────────────────────
const SEVERITY_ORDER = { critical: 0, moderate: 1, mild: 2, normal: 3 };

function openPrep() {
  const r = state.lastReport;
  if (!r) { showToast('Run an analysis first — the prep sheet is built from your report.', 'error'); return; }

  document.getElementById('prep-name').textContent = session && !session.guest ? session.name : '';
  document.getElementById('prep-date').textContent = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

  // Top findings: worst severity first, max 5, skip normals unless nothing else
  const findings = [...(r.findings || [])]
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
  const flagged = findings.filter(f => (f.status || '').toLowerCase() !== 'normal');
  const top = (flagged.length ? flagged : findings).slice(0, 5);

  const fl = document.getElementById('prep-findings');
  fl.innerHTML = '';
  top.forEach(f => {
    const li = document.createElement('li');
    li.innerHTML = `<strong>${escapeHtml(f.parameter)}:</strong> ${escapeHtml(f.value)}${f.reference_range ? ` <span class="prep-ref">(healthy: ${escapeHtml(f.reference_range)})</span>` : ''}`;
    fl.appendChild(li);
  });

  const ql = document.getElementById('prep-questions');
  ql.innerHTML = '';
  (r.questions_for_doctor || []).forEach(q => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="prep-check" aria-hidden="true"></span><span>${escapeHtml(q.question)}</span>`;
    ql.appendChild(li);
  });

  showView('prep-view');
}

// ── NUTRITION GUIDANCE ────────────────────────────────────
// Maps a finding (parameter keywords + high/low direction) to everyday foods
// that support that value. Deliberately conservative: food-first, no dosing,
// no supplements beyond "talk to your doctor".
const NUTRITION_RULES = [
  {
    match: /h(a?)emoglobin|\bhgb\b|\bhb\b|iron|ferritin|\brbc\b|red blood/i, when: 'low',
    label: 'Iron & blood building',
    why: 'Low hemoglobin or iron stores often respond well to iron-rich foods, especially paired with vitamin C for absorption.',
    foods: [['🥬','Spinach'],['🫘','Lentils & beans'],['🥩','Lean red meat'],['🍗','Chicken liver'],['🎃','Pumpkin seeds'],['🍊','Citrus (helps absorption)'],['🌰','Dates & raisins'],['🥦','Broccoli']],
  },
  {
    match: /vitamin\s*d|25-?oh|calcidiol/i, when: 'low',
    label: 'Vitamin D support',
    why: 'Vitamin D comes from sunlight and a short list of foods — worth combining both.',
    foods: [['🐟','Salmon & sardines'],['🥚','Egg yolks'],['🍄','Mushrooms (sun-exposed)'],['🥛','Fortified milk'],['🌾','Fortified cereals'],['☀️','15–20 min morning sun']],
  },
  {
    match: /vitamin\s*b\s*12|cobalamin/i, when: 'low',
    label: 'Vitamin B12 support',
    why: 'B12 is found almost only in animal foods, so vegetarians often need fortified options.',
    foods: [['🐟','Fish & shellfish'],['🥚','Eggs'],['🥛','Milk & yogurt'],['🧀','Cheese'],['🌾','Fortified cereals'],['🍚','Nutritional yeast']],
  },
  {
    match: /calcium/i, when: 'low',
    label: 'Calcium support',
    why: 'Calcium works alongside vitamin D — dairy is the classic source, but greens and seeds count too.',
    foods: [['🥛','Milk & yogurt'],['🧀','Cheese'],['🥬','Kale & bok choy'],['🌱','Sesame seeds / tahini'],['🐟','Sardines with bones'],['🫘','White beans']],
  },
  {
    match: /potassium/i, when: 'low',
    label: 'Potassium support',
    why: 'Potassium helps regulate blood pressure and muscle function; most produce is rich in it.',
    foods: [['🍌','Bananas'],['🥔','Potatoes (with skin)'],['🥑','Avocado'],['🍠','Sweet potato'],['🫘','Beans'],['🍈','Melon'],['🥬','Leafy greens']],
  },
  {
    match: /magnesium/i, when: 'low',
    label: 'Magnesium support',
    why: 'Magnesium supports muscles, nerves, and sleep — nuts and whole grains carry the most.',
    foods: [['🌰','Almonds & cashews'],['🎃','Pumpkin seeds'],['🍫','Dark chocolate'],['🥬','Spinach'],['🌾','Whole grains'],['🫘','Black beans']],
  },
  {
    match: /zinc/i, when: 'low',
    label: 'Zinc support',
    why: 'Zinc supports immunity and healing; meat and seeds are the richest everyday sources.',
    foods: [['🦪','Oysters & shellfish'],['🥩','Beef'],['🎃','Pumpkin seeds'],['🫘','Chickpeas'],['🌰','Cashews'],['🥛','Yogurt']],
  },
  {
    match: /folate|folic/i, when: 'low',
    label: 'Folate support',
    why: 'Folate is abundant in greens and legumes — light cooking preserves more of it.',
    foods: [['🥬','Spinach & greens'],['🫘','Lentils'],['🥦','Broccoli'],['🥑','Avocado'],['🍊','Oranges'],['🌾','Fortified grains']],
  },
  {
    match: /albumin|total protein/i, when: 'low',
    label: 'Protein support',
    why: 'Low albumin can reflect low protein intake; spreading protein across meals helps.',
    foods: [['🥚','Eggs'],['🍗','Chicken & fish'],['🫘','Lentils & beans'],['🥛','Greek yogurt'],['🧀','Paneer / cottage cheese'],['🌰','Nuts']],
  },
  {
    match: /\bhdl\b/i, when: 'low',
    label: 'Raising HDL ("good" cholesterol)',
    why: 'Healthy fats and regular movement are the food-and-lifestyle pair that lifts HDL.',
    foods: [['🥑','Avocado'],['🫒','Olive oil'],['🐟','Fatty fish'],['🌰','Walnuts & almonds'],['🫘','Beans'],['🏃','Regular exercise']],
  },
  {
    match: /\bldl\b|total cholesterol|non-?hdl/i, when: 'high',
    label: 'Lowering LDL cholesterol',
    why: 'Soluble fibre binds cholesterol, and swapping saturated fats for unsaturated ones helps most.',
    foods: [['🌾','Oats & barley'],['🫘','Beans & lentils'],['🍎','Apples & pears'],['🌰','Almonds & walnuts'],['🫒','Olive oil (swap for butter)'],['🐟','Fatty fish'],['🍆','Okra & eggplant']],
  },
  {
    match: /triglyceride/i, when: 'high',
    label: 'Lowering triglycerides',
    why: 'Cutting added sugar and refined carbs matters most; omega-3s directly lower triglycerides.',
    foods: [['🐟','Salmon & sardines'],['🥬','Leafy greens'],['🌾','Whole grains over white'],['🫘','Legumes'],['🚫🥤','Fewer sugary drinks'],['🌰','Chia & flax seeds']],
  },
  {
    match: /glucose|\bhba1c\b|a1c|sugar/i, when: 'high',
    label: 'Steadying blood sugar',
    why: 'Fibre-rich, low-glycemic foods slow sugar absorption and reduce spikes.',
    foods: [['🌾','Oats & whole grains'],['🫘','Beans & chickpeas'],['🥦','Non-starchy vegetables'],['🌰','Nuts'],['🍓','Berries over juice'],['🥗','Vinegar-dressed salads'],['🚶','Post-meal walks']],
  },
  {
    match: /sodium/i, when: 'high',
    label: 'Reducing sodium',
    why: 'Most sodium hides in packaged and restaurant food, not the salt shaker.',
    foods: [['🍅','Fresh over canned'],['🍋','Lemon & herbs for flavour'],['🥔','Potassium-rich produce'],['🚫🥫','Fewer processed snacks'],['🍚','Home-cooked meals']],
  },
  {
    match: /uric acid|urate/i, when: 'high',
    label: 'Lowering uric acid',
    why: 'Hydration and dairy help clear uric acid; organ meats and sugary drinks raise it.',
    foods: [['💧','Plenty of water'],['🥛','Low-fat dairy'],['🍒','Cherries'],['🥦','Vegetables'],['☕','Coffee (moderate)'],['🚫🍺','Less alcohol & organ meat']],
  },
  {
    match: /creatinine|\begfr\b|urea|\bbun\b/i, when: 'high',
    label: 'Kidney-friendly eating',
    why: 'When kidney markers drift, moderating salt and very high protein loads eases the workload — but changes here should be doctor-guided.',
    foods: [['💧','Steady hydration'],['🥗','More plants, less processed'],['🧂','Lower salt'],['🍎','Apples & berries'],['⚕️','Ask about protein targets']],
  },
  {
    match: /blood pressure|systolic|diastolic|hypertension/i, when: 'high',
    label: 'DASH-style eating for blood pressure',
    why: 'The DASH pattern — produce, whole grains, low-fat dairy, less salt — reliably lowers blood pressure.',
    foods: [['🥬','Leafy greens'],['🍌','Bananas'],['🫐','Berries'],['🥛','Low-fat dairy'],['🌾','Whole grains'],['🧂','Less salt'],['🌰','Unsalted nuts']],
  },
  {
    match: /\btsh\b|thyroid/i, when: 'high',
    label: 'Thyroid-supportive nutrition',
    why: 'A high TSH often means an underactive thyroid; iodine and selenium are its raw materials.',
    foods: [['🧂','Iodized salt'],['🐟','Fish & seaweed'],['🌰','Brazil nuts (selenium)'],['🥚','Eggs'],['🥛','Dairy']],
  },
];

function nutritionFor(finding) {
  const status = (finding.status || '').toLowerCase();
  if (status === 'normal') return null;
  const direction = status === 'low' ? 'low' : 'high';   // treat "abnormal" as high-side caution
  return NUTRITION_RULES.find(r => r.when === direction && r.match.test(finding.parameter || '')) || null;
}

function renderNutrition(findings) {
  const list = document.getElementById('nutrition-list');
  if (!list) return;
  list.innerHTML = '';

  const seen = new Set();
  const cards = [];
  findings.forEach(f => {
    const rule = nutritionFor(f);
    if (!rule || seen.has(rule.label)) return;
    seen.add(rule.label);
    cards.push({ rule, finding: f });
  });

  if (cards.length === 0) {
    list.innerHTML = `<div class="nutri-empty">No targeted nutrition suggestions this time — your flagged values don't map to a food-first fix, or everything is in range. A balanced plate (half vegetables and fruit, a quarter whole grains, a quarter protein) is still the best daily default.</div>`;
    return;
  }

  cards.forEach(({ rule, finding }) => {
    const div = document.createElement('div');
    div.className = 'nutri-card';
    div.innerHTML = `
      <div class="nutri-head">
        <span class="nutri-param">${escapeHtml(rule.label)}</span>
        <span class="finding-ref">for ${escapeHtml(finding.parameter)} · ${escapeHtml(finding.value || '')}</span>
      </div>
      <p class="nutri-why">${escapeHtml(rule.why)}</p>
      <div class="nutri-foods">
        ${rule.foods.map(([emoji, name]) => `<span class="food-chip"><span aria-hidden="true">${emoji}</span>${escapeHtml(name)}</span>`).join('')}
      </div>`;
    list.appendChild(div);
  });
}

// ── CHAT ASSISTANT ────────────────────────────────────────
const chat = {
  open: false,
  history: [],       // {role, content} pairs sent to the API
  busy: false,
  greeted: false,
};

const CHAT_SUGGESTIONS_DEFAULT = [
  'What can ClearChart do?',
  'What does LDL mean?',
  'How do I prepare for a blood test?',
];
const CHAT_SUGGESTIONS_REPORT = [
  'Explain my report simply',
  'Which finding matters most?',
  'What should I eat more of?',
];

function toggleChat() {
  chat.open = !chat.open;
  document.getElementById('chat-panel').classList.toggle('open', chat.open);
  document.getElementById('chat-fab').classList.toggle('open', chat.open);
  if (chat.open) {
    if (!chat.greeted) {
      chat.greeted = true;
      const name = session && !session.guest ? ` ${session.name.trim().split(/\s+/)[0]}` : '';
      addChatMsg('bot', `Hi${name}! I'm the ClearChart assistant. Ask me about your report, a lab value, or any medical term you'd like in plain English.`);
      renderChatSuggestions();
    }
    setTimeout(() => document.getElementById('chat-input').focus(), 220);
  }
}

function renderChatSuggestions() {
  const wrap = document.getElementById('chat-suggest');
  const items = state.lastReport ? CHAT_SUGGESTIONS_REPORT : CHAT_SUGGESTIONS_DEFAULT;
  wrap.innerHTML = items
    .map(s => `<button class="suggest-chip" onclick="useSuggestion(this)">${escapeHtml(s)}</button>`)
    .join('');
}

function useSuggestion(btn) {
  document.getElementById('chat-input').value = btn.textContent;
  sendChat();
}

function addChatMsg(role, text) {
  const msgs = document.getElementById('chat-msgs');
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}

function addTypingIndicator() {
  const msgs = document.getElementById('chat-msgs');
  const div = document.createElement('div');
  div.className = 'msg bot typing';
  div.innerHTML = '<i></i><i></i><i></i>';
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}

function buildReportContext() {
  const r = state.lastReport;
  if (!r) return null;
  const findings = (r.findings || [])
    .map(f => `- ${f.parameter}: ${f.value} (${f.status}${f.reference_range ? `, ref ${f.reference_range}` : ''})`)
    .join('\n');
  return [
    `Urgency: ${r.urgency}`,
    `Summary: ${r.summary}`,
    findings ? `Findings:\n${findings}` : '',
  ].filter(Boolean).join('\n').slice(0, 7500);
}

async function sendChat() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || chat.busy) return;

  input.value = '';
  autosizeChatInput();
  document.getElementById('chat-suggest').innerHTML = '';

  addChatMsg('user', text);
  chat.history.push({ role: 'user', content: text });
  chat.busy = true;
  document.getElementById('chat-send').disabled = true;
  const typing = addTypingIndicator();

  try {
    const res = await fetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        history: chat.history.slice(0, -1).slice(-10),
        report_context: buildReportContext(),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'The assistant is unavailable right now.');

    typing.remove();
    addChatMsg('bot', data.reply);
    chat.history.push({ role: 'assistant', content: data.reply });
  } catch (err) {
    typing.remove();
    const offline = err instanceof TypeError;
    addChatMsg('bot', offline
      ? "I can't reach the ClearChart server right now. Check that the backend is running, then try again."
      : err.message);
  } finally {
    chat.busy = false;
    document.getElementById('chat-send').disabled = false;
    renderChatSuggestions();
  }
}

function onChatKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
}

function autosizeChatInput() {
  const input = document.getElementById('chat-input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 96) + 'px';
}

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
