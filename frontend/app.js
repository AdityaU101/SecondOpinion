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
    initProfiles();
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

  // Summary (escaped, then medical terms become interactive popovers)
  document.getElementById('summary-text').innerHTML = linkifyTerms(escapeHtml(report.summary));
  if (report.patient_context) {
    document.getElementById('context-card').style.display = '';
    document.getElementById('context-text').innerHTML = linkifyTerms(escapeHtml(report.patient_context));
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
        <p class="q-text">${linkifyTerms(escapeHtml(q.question))}</p>
        ${q.context ? `<p class="q-context">${linkifyTerms(escapeHtml(q.context))}</p>` : ''}
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

  // "What changed since the last report" — deterministic, server-computed
  loadChanges(state.currentJobId);

  // Follow-up recommendations for this report (deterministic tracker)
  loadRecommendations(state.currentJobId);
}

// ── WHAT CHANGED SINCE LAST REPORT ────────────────────────
// The backend diffs this report against the profile's most recent prior
// report (pure dict math, no LLM, nothing stored). Guests send their prior
// report from localStorage since their history lives on-device.

const CHANGE_CHIP = {
  newly_abnormal: { cls: 'chg-red',   text: (c) => `New: ${c.parameter}` },
  worsened:       { cls: 'chg-red',   text: (c) => `${c.parameter} ${c.direction === 'down' ? '▼' : '▲'} worsened` },
  improved:       { cls: 'chg-green', text: (c) => `${c.parameter} ${c.direction === 'down' ? '▼' : '▲'} improved` },
  normalized:     { cls: 'chg-green', text: (c) => `${c.parameter} ✓ back in range` },
};

function guestPriorSupplement(jobId) {
  if (session.token) return {};
  try {
    const active = activeProfile();
    const entries = (JSON.parse(localStorage.getItem(LOCAL_HISTORY_KEY) || '[]'))
      .filter(e => e.profile_id === active.id || (!e.profile_id && active.is_default));
    const idx = entries.findIndex(e => e.job_id === jobId);
    const prior = idx >= 0 ? entries[idx + 1] : entries[0];
    if (!prior || prior.job_id === jobId) return {};
    return { prior: {
      job_id: prior.job_id,
      created_at: prior.created_at,
      findings: (prior.report?.findings || []).map(f => ({
        parameter: f.parameter, numeric_value: f.numeric_value, unit: f.unit,
        status: f.status, ref_low: f.ref_low, ref_high: f.ref_high,
      })),
    }};
  } catch { return {}; }
}

async function loadChanges(jobId) {
  const strip = document.getElementById('changes-strip');
  strip.style.display = 'none';
  strip.innerHTML = '';
  if (!jobId) return;

  let data;
  try {
    const res = await fetch(`${API_BASE}/jobs/${jobId}/changes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(guestPriorSupplement(jobId)),
    });
    if (!res.ok) return;                 // strip is optional — fail silently
    data = await res.json();
  } catch { return; }

  if (!data.has_prior) {
    strip.innerHTML = `<span class="chg-label">Since last report</span><span class="chg-empty">${escapeHtml(data.message || 'Upload another report in the future to track changes over time.')}</span>`;
    strip.style.display = '';
    return;
  }

  const chips = [];
  (data.changes || []).forEach(c => {
    const spec = CHANGE_CHIP[c.change];
    if (spec) chips.push(`<span class="chg-chip ${spec.cls}" title="${escapeHtml(c.note || '')}">${escapeHtml(spec.text(c))}</span>`);
  });
  const counts = data.counts || {};
  if (counts.unchanged) chips.push(`<span class="chg-chip chg-gray">${counts.unchanged} unchanged</span>`);
  if (counts.not_remeasured) chips.push(`<span class="chg-chip chg-amber">${counts.not_remeasured} not re-measured</span>`);

  if (!chips.length) return;
  const when = data.prior_date ? ` (vs ${shortDate(data.prior_date)})` : '';
  strip.innerHTML = `<span class="chg-label">Since last report${escapeHtml(when)}</span>` + chips.join('');
  strip.style.display = '';
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
      <button type="button" class="finding-param finding-param-btn" title="Explain this value">
        ${escapeHtml(f.parameter)}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
      </button>
      <div class="finding-meta">
        <span class="finding-value" style="color:${valueColor}">${escapeHtml(f.value)}</span>
        <span class="status-chip ${statusClass}">${f.status.toUpperCase()}</span>
        ${f.reference_range ? `<span class="finding-ref">Ref: ${escapeHtml(f.reference_range)}</span>` : ''}
      </div>
    </div>
    ${renderComparisonBar(f)}
    <p class="finding-explanation">${linkifyTerms(escapeHtml(f.explanation))}</p>`;
  card.querySelector('.finding-param-btn').addEventListener('click', () => openExplain(f));
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
  if (!(session && session.token)) return {};
  const headers = { Authorization: `Bearer ${session.token}` };
  // Scope server-side writes/reads to the active family profile.
  if (profileStore.activeId && !String(profileStore.activeId).startsWith('local')) {
    headers['X-Profile-Id'] = profileStore.activeId;
  }
  return headers;
}

// ── FAMILY PROFILES ───────────────────────────────────────
// Signed-in: profiles live server-side (/api/v1/profiles).
// Guests: profiles live in localStorage, same shape, ids prefixed "local-".

const profileStore = { list: [], activeId: null };

const LOCAL_PROFILES_KEY = 'clearchart-profiles';
const ACTIVE_PROFILE_KEY = 'clearchart-active-profile';

function activeProfile() {
  return profileStore.list.find(p => p.id === profileStore.activeId) || profileStore.list[0] || { id: null, name: session?.name || 'Me', relation: 'Self', is_default: true };
}

function saveLocalProfiles() {
  localStorage.setItem(LOCAL_PROFILES_KEY, JSON.stringify(profileStore.list));
}

async function initProfiles() {
  if (session.token) {
    try {
      const res = await fetch(`${API_BASE}/profiles`, { headers: { Authorization: `Bearer ${session.token}` } });
      if (!res.ok) throw new Error();
      profileStore.list = (await res.json()).profiles || [];
    } catch {
      // Offline backend → behave like a single-profile account.
      profileStore.list = [{ id: null, name: session.name, relation: 'Self', is_default: true }];
    }
  } else {
    try {
      profileStore.list = JSON.parse(localStorage.getItem(LOCAL_PROFILES_KEY) || 'null') || [];
    } catch { profileStore.list = []; }
    if (profileStore.list.length === 0) {
      profileStore.list = [{ id: 'local-me', name: 'Me', relation: 'Self', is_default: true }];
      saveLocalProfiles();
    }
  }

  const saved = localStorage.getItem(ACTIVE_PROFILE_KEY);
  profileStore.activeId = profileStore.list.some(p => p.id === saved)
    ? saved
    : (profileStore.list.find(p => p.is_default) || profileStore.list[0]).id;

  renderProfileChip();
  renderProfileMenu();
}

function renderProfileChip() {
  const p = activeProfile();
  document.getElementById('chip-avatar').textContent = ccInitials(p.name);
  document.getElementById('chip-name').textContent = p.name;

  const greeting = document.getElementById('app-greeting');
  if (greeting) {
    greeting.textContent = p.is_default
      ? (session.guest ? "Let's read your records together" : `Let's read your records, ${p.name}`)
      : `Reading records for ${p.name}`;
  }
  const medsName = document.getElementById('meds-profile-name');
  if (medsName) medsName.textContent = p.is_default ? (session.guest ? 'you' : p.name) : p.name;
}

function renderProfileMenu() {
  const list = document.getElementById('pm-list');
  list.innerHTML = '';
  profileStore.list.forEach(p => {
    const btn = document.createElement('button');
    btn.className = 'pm-item' + (p.id === profileStore.activeId ? ' active' : '');
    btn.innerHTML = `
      <span class="chip-avatar">${escapeHtml(ccInitials(p.name))}</span>
      <span class="pm-item-info">
        <span class="pm-item-name">${escapeHtml(p.name)}</span>
        <span class="pm-item-rel">${escapeHtml(p.relation || '')}</span>
      </span>
      ${p.id === profileStore.activeId ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>' : ''}`;
    btn.addEventListener('click', () => switchProfile(p.id));
    list.appendChild(btn);
  });

  document.getElementById('pm-account').textContent = session.guest
    ? 'Guest session — profiles stay on this device'
    : (session.email ? `${session.name} · ${session.email}` : session.name);
}

function toggleProfileMenu(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById('profile-menu');
  const open = menu.classList.toggle('open');
  document.getElementById('profile-btn').setAttribute('aria-expanded', open);
  if (!open) hideAddProfile();
}

document.addEventListener('click', (e) => {
  const menu = document.getElementById('profile-menu');
  if (menu && menu.classList.contains('open') && !e.target.closest('.profile-wrap')) {
    menu.classList.remove('open');
    hideAddProfile();
  }
});

function showAddProfile() {
  document.getElementById('pm-add-btn').style.display = 'none';
  document.getElementById('pm-add-form').classList.add('open');
  document.getElementById('pm-name').focus();
}

function hideAddProfile() {
  document.getElementById('pm-add-btn').style.display = '';
  document.getElementById('pm-add-form').classList.remove('open');
}

async function submitAddProfile(e) {
  e.preventDefault();
  const name = document.getElementById('pm-name').value.trim();
  const relation = document.getElementById('pm-relation').value;
  if (!name) return;

  if (session.token) {
    try {
      const res = await fetch(`${API_BASE}/profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ name, relation }),
      });
      if (!res.ok) throw new Error();
      profileStore.list.push(await res.json());
    } catch {
      showToast('Could not create the profile. Is the backend running?', 'error');
      return;
    }
  } else {
    profileStore.list.push({ id: `local-${Date.now()}`, name, relation, is_default: false });
    saveLocalProfiles();
  }

  document.getElementById('pm-name').value = '';
  hideAddProfile();
  renderProfileMenu();
  switchProfile(profileStore.list[profileStore.list.length - 1].id);
}

function switchProfile(id) {
  if (id === profileStore.activeId) {
    document.getElementById('profile-menu').classList.remove('open');
    return;
  }
  profileStore.activeId = id;
  localStorage.setItem(ACTIVE_PROFILE_KEY, id);

  // Each profile gets its own context everywhere.
  state.lastReport = null;
  state.currentJobId = null;
  chat.history = [];
  chat.greeted = false;
  document.getElementById('chat-msgs').innerHTML = '';
  document.getElementById('chat-suggest').innerHTML = '';
  meds.list = [];
  meds.loaded = false;
  document.getElementById('med-results').innerHTML = '';

  renderProfileChip();
  renderProfileMenu();
  document.getElementById('profile-menu').classList.remove('open');

  const p = activeProfile();
  showToast(`Now viewing ${p.name}'s records`, 'info');

  // Refresh whichever profile-scoped view is on screen.
  if (document.getElementById('history-view').classList.contains('active')) showHistory();
  else if (document.getElementById('meds-view').classList.contains('active')) showMeds();
  else showView('upload-view');
}

// ── REPORT HISTORY ────────────────────────────────────────
// Signed-in users: history lives server-side (jobs.user_id → /reports).
// Guests: a device-local copy in localStorage, capped at 20 entries.

const LOCAL_HISTORY_KEY = 'clearchart-history';

function recordHistory(jobId, report) {
  if (session && session.token) return;   // server already owns it
  try {
    const entries = JSON.parse(localStorage.getItem(LOCAL_HISTORY_KEY) || '[]');
    entries.unshift({
      job_id: jobId,
      created_at: new Date().toISOString(),
      profile_id: profileStore.activeId,
      report,
    });
    localStorage.setItem(LOCAL_HISTORY_KEY, JSON.stringify(entries.slice(0, 40)));
  } catch (e) { console.warn('Could not save local history:', e); }
}

async function loadHistoryEntries() {
  if (session && session.token) {
    const pid = profileStore.activeId ? `?profile_id=${encodeURIComponent(profileStore.activeId)}` : '';
    const res = await fetch(`${API_BASE}/reports${pid}`, { headers: authHeaders() });
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
  // Guest: local entries carry the full report; scope to the active profile.
  // Entries saved before profiles existed (no profile_id) belong to the default.
  const active = activeProfile();
  const entries = (JSON.parse(localStorage.getItem(LOCAL_HISTORY_KEY) || '[]'))
    .filter(e => e.profile_id === active.id || (!e.profile_id && active.is_default));
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
  resetCompareSelection();

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
  loadPendingRecs(entries);
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
      <div class="history-actions">
        <button class="btn-outline-sm history-packet">Visit packet
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        </button>
        <button class="btn-outline-sm history-open">Open report
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
        </button>
      </div>
    </div>`;

  div.querySelector('.history-open').addEventListener('click', () => openHistoryReport(entry));
  div.querySelector('.history-packet').addEventListener('click', () => loadPacket(entry.job_id, 'history-view'));
  div.dataset.jobId = entry.job_id;
  div.addEventListener('click', () => { if (compare.selecting) toggleCompareSelect(entry.job_id, div); });
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

  // Longitudinal summary — generated ONLY from the values above, never invented.
  const summaryEl = document.getElementById('trends-summary');
  const sentences = series.slice(0, 4).map(computeTrendSentence).filter(Boolean);
  if (sentences.length) {
    summaryEl.style.display = '';
    summaryEl.innerHTML = sentences.map(s => `<p>${s}</p>`).join('');
  } else {
    summaryEl.style.display = 'none';
  }
}

/* Build one grounded sentence per tracked metric: direction, size of the
   change, and where the latest value sits against the healthy range. */
function computeTrendSentence(series) {
  const pts = series.points;
  const first = pts[0].value;
  const latest = pts[pts.length - 1].value;
  if (first === 0 && latest === 0) return null;

  const pct = first !== 0 ? Math.round(((latest - first) / Math.abs(first)) * 100) : null;
  const unit = series.unit ? ` ${series.unit}` : '';
  const span = `across ${pts.length} reports (${fmt(first)} → ${fmt(latest)}${unit})`;

  // Direction: steady / steadily risen / steadily fallen / fluctuated
  const diffs = [];
  for (let i = 1; i < pts.length; i++) diffs.push(pts[i].value - pts[i - 1].value);
  const rises = diffs.filter(d => d > 0).length;
  const falls = diffs.filter(d => d < 0).length;

  let movement;
  if (pct !== null && Math.abs(pct) < 3) movement = 'has stayed steady';
  else if (falls === 0) movement = `has ${diffs.length > 1 ? 'steadily ' : ''}risen ${Math.abs(pct)}%`;
  else if (rises === 0) movement = `has ${diffs.length > 1 ? 'steadily ' : ''}fallen ${Math.abs(pct)}%`;
  else movement = `has fluctuated, ending ${latest > first ? 'up' : 'down'} ${Math.abs(pct)}%`;

  // Position against the healthy range, judged from the latest report's refs
  const ref = pts[pts.length - 1];
  const hasHigh = ref.ref_high !== null && ref.ref_high !== undefined && ref.ref_high < 9000;
  const hasLow = ref.ref_low !== null && ref.ref_low !== undefined && ref.ref_low > 0;
  let position = '';
  if (hasHigh && latest > ref.ref_high) {
    const prevOut = first > ref.ref_high;
    position = prevOut && latest < first
      ? ' — moving toward the healthy range, but still above it'
      : ' and remains above the healthy range';
  } else if (hasLow && latest < ref.ref_low) {
    const prevOut = first < ref.ref_low;
    position = prevOut && latest > first
      ? ' — moving toward the healthy range, but still below it'
      : ' and remains below the healthy range';
  } else if (hasHigh || hasLow) {
    const wasOut = (hasHigh && first > ref.ref_high) || (hasLow && first < ref.ref_low);
    position = wasOut ? ' and is now within the healthy range' : ' and stays within the healthy range';
  }

  return `<strong>${escapeHtml(series.name)}</strong> ${movement} ${escapeHtml(span)}${position}.`;
}

function buildTrendCard(series, index) {
  const div = document.createElement('div');
  div.className = 'trend-card';
  div.style.animationDelay = `${index * 0.07}s`;

  const pts = series.points;
  const latest = pts[pts.length - 1];
  const previous = pts[pts.length - 2];
  const first = pts[0];
  const delta = latest.value - previous.value;
  const deltaText = delta === 0 ? 'no change'
    : `${delta > 0 ? '▲' : '▼'} ${fmt(Math.abs(delta))} since last report`;
  const totalPct = first.value !== 0
    ? Math.round(((latest.value - first.value) / Math.abs(first.value)) * 100)
    : null;
  const pctText = totalPct === null || totalPct === 0 ? ''
    : `${totalPct > 0 ? '+' : '−'}${Math.abs(totalPct)}% overall`;
  const latestStatus = (latest.status || '').toLowerCase();
  const statusClass = { high: 'chip-high', low: 'chip-low', abnormal: 'chip-abnormal', normal: 'chip-normal' }[latestStatus] || 'chip-normal';

  // Healthy range, phrased like the findings tab does
  const hasHigh = latest.ref_high !== null && latest.ref_high !== undefined && latest.ref_high < 9000;
  const hasLow = latest.ref_low !== null && latest.ref_low !== undefined && latest.ref_low > 0;
  const unit = series.unit ? ` ${series.unit}` : '';
  let rangeText = '';
  if (hasLow && hasHigh) rangeText = `Healthy: ${fmt(latest.ref_low)}–${fmt(latest.ref_high)}${unit}`;
  else if (hasHigh) rangeText = `Healthy: ≤ ${fmt(latest.ref_high)}${unit}`;
  else if (hasLow) rangeText = `Healthy: ≥ ${fmt(latest.ref_low)}${unit}`;

  div.innerHTML = `
    <div class="trend-top">
      <span class="trend-name">${escapeHtml(series.name)}</span>
      <span class="status-chip ${statusClass}">${escapeHtml((latest.status || '').toUpperCase())}</span>
    </div>
    <div class="trend-readout">
      <span class="trend-value">${fmt(latest.value)}${series.unit ? ' ' + escapeHtml(series.unit) : ''}</span>
      <span class="trend-delta">${escapeHtml(deltaText)}</span>
      ${pctText ? `<span class="trend-pct">${escapeHtml(pctText)}</span>` : ''}
    </div>
    ${buildSparklineSVG(pts)}
    <div class="trend-dates">
      <span>${escapeHtml(shortDate(first.date))}</span>
      ${rangeText ? `<span class="trend-range">${escapeHtml(rangeText)}</span>` : ''}
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

// ── FOLLOW-UP RECOMMENDATION TRACKER ──────────────────────
// Recommendations are generated ONCE per report by a deterministic rule
// table on the backend, then persisted — ticking a checkbox or saving a
// note is a tiny PATCH; generation and the LLM never re-run on state
// changes. Works identically for guests (their jobs live server-side).

const recTracker = { byId: {} };

const REC_PRIORITY_CHIP = { high: 'chip-high', medium: 'chip-abnormal', low: 'chip-normal' };

async function loadRecommendations(jobId) {
  const list = document.getElementById('followups-list');
  const badge = document.getElementById('followup-badge');
  list.innerHTML = '';
  badge.style.display = 'none';
  if (!jobId) return;

  try {
    const res = await fetch(`${API_BASE}/jobs/${jobId}/recommendations`, {
      method: 'POST', headers: authHeaders(),
    });
    if (!res.ok) throw new Error();
    const items = (await res.json()).recommendations || [];
    items.forEach(r => { recTracker.byId[r.id] = r; });

    if (!items.length) {
      list.innerHTML = '<div class="nutri-empty">No follow-up items for this report.</div>';
      return;
    }
    items.forEach(r => list.appendChild(buildRecRow(r, false)));
    updateFollowupBadge(items);
  } catch {
    list.innerHTML = '<div class="nutri-empty">Could not load follow-ups. Is the backend running?</div>';
  }
}

function updateFollowupBadge(items) {
  const badge = document.getElementById('followup-badge');
  const pending = items.filter(r => !r.completed).length;
  badge.textContent = pending;
  badge.style.display = pending ? '' : 'none';
}

function buildRecRow(r, compact) {
  const row = document.createElement('div');
  row.className = 'rec-row' + (r.completed ? ' done' : '');
  row.dataset.recId = r.id;

  const cite = r.citation && r.citation.source
    ? `<a class="rec-cite" href="${escapeHtml(r.citation.url || '#')}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.citation.source)}</a>`
    : '';
  const doneAt = r.completed && r.completed_at
    ? `<span class="rec-done-at">Done ${escapeHtml(formatReportDate(r.completed_at))}</span>` : '';

  row.innerHTML = `
    <button class="rec-check" role="checkbox" aria-checked="${!!r.completed}" aria-label="Mark as done">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
    </button>
    <div class="rec-body">
      <div class="rec-top">
        <span class="rec-action">${escapeHtml(r.action)}</span>
        <span class="status-chip ${REC_PRIORITY_CHIP[r.priority] || 'chip-normal'}">${escapeHtml((r.priority || '').toUpperCase())}</span>
      </div>
      ${compact ? '' : `<p class="rec-reason">${linkifyTerms(escapeHtml(r.reason || ''))}</p>`}
      <div class="rec-meta">${cite}${doneAt}</div>
      ${compact ? '' : `
      <div class="rec-note-wrap">
        <button class="rec-note-toggle">${r.note ? 'Edit note' : 'Add note'}</button>
        <span class="rec-note-text">${escapeHtml(r.note || '')}</span>
        <div class="rec-note-form" style="display:none">
          <input class="rec-note-input" maxlength="500" placeholder="Personal note (e.g. booked for 12 Aug)" value="${escapeHtml(r.note || '')}"/>
          <button class="btn-outline-sm rec-note-save">Save</button>
        </div>
      </div>`}
    </div>`;

  row.querySelector('.rec-check').addEventListener('click', () => toggleRecComplete(r.id, row));
  if (!compact) {
    const toggle = row.querySelector('.rec-note-toggle');
    const form = row.querySelector('.rec-note-form');
    toggle.addEventListener('click', () => {
      form.style.display = form.style.display === 'none' ? '' : 'none';
      if (form.style.display !== 'none') form.querySelector('.rec-note-input').focus();
    });
    form.querySelector('.rec-note-save').addEventListener('click', () => saveRecNote(r.id, row));
    form.querySelector('.rec-note-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); saveRecNote(r.id, row); }
    });
  }
  return row;
}

async function patchRecommendation(id, payload) {
  const res = await fetch(`${API_BASE}/recommendations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Could not save. Is the backend running?');
  return res.json();
}

async function toggleRecComplete(id, row) {
  const rec = recTracker.byId[id];
  if (!rec) return;
  try {
    const updated = await patchRecommendation(id, { completed: !rec.completed });
    recTracker.byId[id] = updated;
    const rebuilt = buildRecRow(updated, row.classList.contains('compact') || row.closest('#pending-recs-list') !== null);
    row.replaceWith(rebuilt);
    const all = Object.values(recTracker.byId).filter(r => r.job_id === updated.job_id);
    updateFollowupBadge(all);
    if (updated.completed && row.closest('#pending-recs-list')) rebuilt.remove();   // pending card shows open items only
  } catch (err) { showToast(err.message, 'error'); }
}

async function saveRecNote(id, row) {
  const input = row.querySelector('.rec-note-input');
  try {
    const updated = await patchRecommendation(id, { note: input.value });
    recTracker.byId[id] = updated;
    row.replaceWith(buildRecRow(updated, false));
    showToast('Note saved', 'info');
  } catch (err) { showToast(err.message, 'error'); }
}

/* Pending follow-ups card on the History page. */
async function loadPendingRecs(entries) {
  const card = document.getElementById('pending-recs-card');
  const list = document.getElementById('pending-recs-list');
  card.style.display = 'none';
  list.innerHTML = '';

  try {
    let url;
    if (session.token) {
      const pid = profileStore.activeId ? `?profile_id=${encodeURIComponent(profileStore.activeId)}` : '';
      url = `${API_BASE}/recommendations/pending${pid}`;
    } else {
      const ids = (entries || []).map(e => e.job_id).slice(0, 40).join(',');
      if (!ids) return;
      url = `${API_BASE}/recommendations/pending?job_ids=${encodeURIComponent(ids)}`;
    }
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) return;
    const items = (await res.json()).recommendations || [];
    if (!items.length) return;
    items.forEach(r => { recTracker.byId[r.id] = r; });
    items.slice(0, 8).forEach(r => list.appendChild(buildRecRow(r, true)));
    card.style.display = '';
  } catch { /* the card is optional enrichment — stay hidden */ }
}

// ── REPORT COMPARISON MODE ────────────────────────────────
// The user picks two saved reports; the BACKEND computes a deterministic
// diff (new / resolved / improved / worsened / unchanged / not re-measured)
// from the stored findings. The LLM only rephrases that computed result —
// the frontend just renders what the server decided.

const compare = { selecting: false, selected: [], busy: false, current: null };

function resetCompareSelection() {
  compare.selecting = false;
  compare.selected = [];
  const bar = document.getElementById('compare-bar');
  if (bar) bar.style.display = 'none';
  const list = document.getElementById('history-list');
  if (list) list.classList.remove('selecting');
  const toggle = document.getElementById('compare-toggle');
  if (toggle) toggle.classList.remove('active');
}

function toggleCompareMode() {
  if (compare.selecting) { resetCompareSelection(); return; }
  const cards = document.querySelectorAll('#history-list .history-card');
  if (cards.length < 2) {
    showToast('You need at least two saved reports to compare.', 'error');
    return;
  }
  compare.selecting = true;
  compare.selected = [];
  document.getElementById('compare-bar').style.display = '';
  document.getElementById('history-list').classList.add('selecting');
  document.getElementById('compare-toggle').classList.add('active');
  cards.forEach(c => c.classList.remove('selected'));
  updateCompareBar();
}

function toggleCompareSelect(jobId, card) {
  const idx = compare.selected.indexOf(jobId);
  if (idx >= 0) {
    compare.selected.splice(idx, 1);
    card.classList.remove('selected');
  } else {
    if (compare.selected.length >= 2) {
      showToast('Two reports at a time — unselect one first.', 'info');
      return;
    }
    compare.selected.push(jobId);
    card.classList.add('selected');
  }
  updateCompareBar();
}

function updateCompareBar() {
  const n = compare.selected.length;
  document.getElementById('compare-bar-text').textContent =
    n === 0 ? 'Select two reports to compare.'
    : n === 1 ? '1 of 2 selected — pick one more.'
    : 'Two reports selected — ready to compare.';
  document.getElementById('compare-run-btn').disabled = n !== 2;
}

async function runCompare(regenerate = false) {
  if (compare.busy || compare.selected.length !== 2) return;
  compare.busy = true;
  const btn = document.getElementById('compare-run-btn');
  btn.disabled = true;
  btn.textContent = 'Comparing…';

  try {
    const res = await fetch(`${API_BASE}/reports/compare${regenerate ? '?regenerate=true' : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ left_job_id: compare.selected[0], right_job_id: compare.selected[1] }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Could not compare these reports.');
    renderCompare(data);
  } catch (err) {
    showToast(err instanceof TypeError
      ? 'Cannot reach the ClearChart server. Make sure the backend is running, then try again.'
      : err.message, 'error');
  } finally {
    compare.busy = false;
    btn.textContent = 'Compare';
    updateCompareBar();
  }
}

const COMPARE_BUCKETS = [
  ['new_abnormalities', 'New abnormalities', 'cvb-red',
   'Values flagged in the latest report that were in range (or not measured) before.'],
  ['resolved', 'Resolved', 'cvb-green',
   'Values that were flagged earlier and are back within the healthy range.'],
  ['improved', 'Improved', 'cvb-green',
   'Still outside the healthy range, but moving toward it.'],
  ['worsened', 'Worsened', 'cvb-red',
   'Still outside the healthy range, and moving away from it.'],
  ['unchanged', 'Unchanged', 'cvb-gray',
   'Little or no meaningful change between the two reports.'],
  ['newly_measured', 'Measured for the first time', 'cvb-gray',
   'Present only in the latest report, and within the healthy range.'],
  ['not_remeasured', 'Not re-measured this time', 'cvb-amber',
   'Present only in the earlier report — no new value exists, so nothing is assumed.'],
];

function cvHead(meta, label) {
  const urgency = meta.urgency || 'routine';
  const urgencyText = { urgent: 'Needs attention', watch: 'Worth discussing', routine: 'All routine' }[urgency] || '';
  return `
    <div class="cv-head-card">
      <p class="cv-head-label">${label}</p>
      <p class="cv-head-date">${escapeHtml(formatReportDate(meta.date))}</p>
      <div class="cv-head-meta">
        <span class="cv-head-src">${escapeHtml(meta.source_name || '')}</span>
        <span class="history-urgency ${escapeHtml(urgency)}">${urgencyText}</span>
      </div>
    </div>`;
}

function cvStatusChip(side) {
  if (!side || !side.status) return '';
  const cls = { high: 'chip-high', low: 'chip-low', abnormal: 'chip-abnormal', normal: 'chip-normal' }[(side.status || '').toLowerCase()] || 'chip-abnormal';
  return `<span class="status-chip ${cls}">${escapeHtml(side.status.toUpperCase())}</span>`;
}

function cvDeltaChip(item) {
  const d = item.delta;
  if (!d || d.direction === 'flat') return '';
  const arrow = d.direction === 'up' ? '▲' : '▼';
  const unit = item.unit ? ` ${item.unit}` : '';
  const pct = d.percent === null || d.percent === undefined ? '' : ` (${d.percent > 0 ? '+' : ''}${d.percent}%)`;
  return `<span class="cv-delta">${arrow} ${fmt(Math.abs(d.absolute))}${escapeHtml(unit)}${escapeHtml(pct)}</span>`;
}

/* Reuse the trends sparkline for a two-point "old → new" mini chart. */
function cvSparkline(item, olderDate, newerDate) {
  if (!item.older || !item.newer) return '';
  if (item.older.numeric_value === null || item.older.numeric_value === undefined) return '';
  if (item.newer.numeric_value === null || item.newer.numeric_value === undefined) return '';
  const pts = [
    { date: olderDate, value: item.older.numeric_value, ref_low: item.older.ref_low, ref_high: item.older.ref_high },
    { date: newerDate, value: item.newer.numeric_value, ref_low: item.newer.ref_low, ref_high: item.newer.ref_high },
  ];
  return `<div class="cv-spark">${buildSparklineSVG(pts)}</div>`;
}

function cvValueLine(item) {
  const unit = item.unit ? ` ${item.unit}` : '';
  const oldV = item.older ? (item.older.numeric_value ?? item.older.value) : null;
  const newV = item.newer ? (item.newer.numeric_value ?? item.newer.value) : null;
  if (oldV !== null && oldV !== undefined && newV !== null && newV !== undefined) {
    return `${typeof oldV === 'number' ? fmt(oldV) : escapeHtml(String(oldV))} → ${typeof newV === 'number' ? fmt(newV) : escapeHtml(String(newV))}${escapeHtml(unit)}`;
  }
  const side = item.newer || item.older;
  return side && side.value ? escapeHtml(String(side.value)) : '';
}

function renderCompare(c) {
  compare.current = c;

  document.getElementById('cv-heads').innerHTML =
    cvHead(c.older, 'Earlier report') +
    `<div class="cv-arrow" aria-hidden="true">→</div>` +
    cvHead(c.newer, 'Latest report');

  document.getElementById('cv-summary').innerHTML = linkifyTerms(escapeHtml(c.summary || ''));
  document.getElementById('cv-summary-src').textContent = c.summary_source === 'llm'
    ? 'Reworded from the computed comparison below — nothing added.'
    : 'Generated directly from the computed comparison below.';

  const wrap = document.getElementById('cv-buckets');
  wrap.innerHTML = '';
  COMPARE_BUCKETS.forEach(([key, title, cls, desc]) => {
    const items = (c.buckets && c.buckets[key]) || [];
    if (!items.length) return;
    const card = document.createElement('div');
    card.className = 'summary-card cv-bucket';
    card.innerHTML = `
      <div class="cv-bucket-head">
        <h3 class="panel-section-title">${title}</h3>
        <span class="cv-count ${cls}">${items.length}</span>
      </div>
      <p class="cv-bucket-desc">${desc}</p>
      ${items.map(item => `
        <div class="cv-row">
          <div class="cv-row-main">
            <div class="cv-row-top">
              <span class="cv-param">${escapeHtml(item.parameter || '')}</span>
              <span class="cv-chips">${cvStatusChip(item.older)}${item.older && item.newer ? '<span class="cv-mini-arrow">→</span>' : ''}${cvStatusChip(item.newer)}${cvDeltaChip(item)}</span>
            </div>
            <p class="cv-values">${cvValueLine(item)}</p>
            <p class="cv-note">${linkifyTerms(escapeHtml(item.note || ''))}</p>
          </div>
          ${cvSparkline(item, c.older.date, c.newer.date)}
        </div>`).join('')}
    `;
    wrap.appendChild(card);
  });

  if (!wrap.children.length) {
    wrap.innerHTML = '<div class="nutri-empty">These two reports share no comparable values.</div>';
  }

  if (c.disclaimer) document.getElementById('cv-disclaimer').textContent = c.disclaimer;
  showView('compare-view');
}

// ── APPOINTMENT PREP ──────────────────────────────────────
const SEVERITY_ORDER = { critical: 0, moderate: 1, mild: 2, normal: 3 };

function openPrep() {
  const r = state.lastReport;
  if (!r) { showToast('Run an analysis first — the prep sheet is built from your report.', 'error'); return; }

  const prepProfile = activeProfile();
  document.getElementById('prep-name').textContent = prepProfile.is_default && session.guest
    ? ''
    : `${prepProfile.name}${prepProfile.is_default ? '' : ` (${prepProfile.relation})`}`;
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

// ── DOCTOR VISIT PACKET ───────────────────────────────────
// Built server-side from the report the system already produced (plus prior
// reports and the medication list) and saved with the job, so it can be
// reopened later without another LLM call. Guests supply their localStorage
// context in the request body; signed-in users get it from the server.

const packet = { current: null, busy: false, from: 'history-view' };

function openPacket(fromView) {
  if (!state.currentJobId) {
    showToast('Run an analysis first — the packet is built from your report.', 'error');
    return;
  }
  loadPacket(state.currentJobId, fromView || 'results-view');
}

function packetBack() {
  showView(packet.from);
}

function downloadPacketPDF() {
  if (!packet.current) return;
  window.open(`${API_BASE}/jobs/${packet.current.job_id}/packet/export`, '_blank');
}

/* Guests keep profiles, meds, and history in localStorage — send that context
   so the server can build the same packet it builds for accounts. */
function guestPacketSupplements() {
  if (session.token) return {};
  const p = activeProfile();
  let meds = [];
  try { meds = (JSON.parse(localStorage.getItem(localMedsKey()) || '[]')).map(m => m.name); } catch {}
  let history = [];
  try {
    history = (JSON.parse(localStorage.getItem(LOCAL_HISTORY_KEY) || '[]'))
      .filter(e => e.profile_id === p.id || (!e.profile_id && p.is_default))
      .slice(0, 20)
      .map(e => ({
        job_id: e.job_id,
        created_at: e.created_at,
        findings: (e.report?.findings || []).map(f => ({
          parameter: f.parameter, numeric_value: f.numeric_value, unit: f.unit,
          status: f.status, ref_low: f.ref_low, ref_high: f.ref_high,
        })),
      }))
      .reverse();   // oldest first, the order the timeline builder expects
  } catch {}
  return {
    profile_name: p.is_default && session.guest ? '' : `${p.name}${p.is_default ? '' : ` (${p.relation})`}`,
    medications: meds.slice(0, 12),
    prior_reports: history,
  };
}

async function loadPacket(jobId, fromView) {
  if (packet.busy) return;
  packet.busy = true;
  packet.from = fromView || 'history-view';

  try {
    // Reuse the saved packet when there is one — no duplicate generation.
    let res = await fetch(`${API_BASE}/jobs/${jobId}/packet`, { headers: authHeaders() });
    if (!res.ok) {
      showToast('Preparing your visit packet…', 'info');
      res = await fetch(`${API_BASE}/jobs/${jobId}/packet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(guestPacketSupplements()),
      });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Could not build the visit packet.');
    renderPacket(data);
  } catch (err) {
    showToast(err instanceof TypeError
      ? 'Cannot reach the ClearChart server. Make sure the backend is running, then try again.'
      : err.message, 'error');
  } finally {
    packet.busy = false;
  }
}

function renderPacket(p) {
  packet.current = p;

  document.getElementById('packet-name').textContent = p.profile_name || '';
  document.getElementById('packet-date').textContent = p.report_date
    ? `Report of ${new Date(p.report_date).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}`
    : '';

  document.getElementById('packet-note').textContent = p.visit_note || '';
  document.getElementById('packet-note-src').textContent = p.visit_note_source === 'llm'
    ? 'Reworded from the verified report values — nothing added.'
    : 'Generated directly from the verified report values.';

  const fl = document.getElementById('packet-findings');
  fl.innerHTML = '';
  if ((p.priority_findings || []).length === 0) {
    fl.innerHTML = '<li>No flagged values in this report.</li>';
  }
  (p.priority_findings || []).forEach(f => {
    const li = document.createElement('li');
    li.innerHTML = `<strong>${escapeHtml(f.parameter)}:</strong> ${escapeHtml(f.value)} `
      + `<span class="pk-status ${escapeHtml((f.status || '').toLowerCase())}">${escapeHtml((f.status || '').toUpperCase())}</span>`
      + (f.reference_range ? ` <span class="prep-ref">(healthy: ${escapeHtml(f.reference_range)})</span>` : '');
    fl.appendChild(li);
  });

  const wellnessSection = document.getElementById('packet-wellness-section');
  const wl = document.getElementById('packet-wellness');
  wl.innerHTML = '';
  wellnessSection.style.display = (p.wellness || []).length ? '' : 'none';
  (p.wellness || []).forEach(d => {
    const color = d.status === 'good' ? 'var(--green)' : d.status === 'watch' ? 'var(--amber)' : 'var(--red)';
    const row = document.createElement('div');
    row.className = 'pk-well';
    row.innerHTML = `
      <span class="pk-well-area">${escapeHtml(d.area)}</span>
      <div class="pk-well-track"><div class="pk-well-fill" style="width:${Math.max(0, Math.min(100, d.score || 0))}%; background:${color}"></div></div>
      <span class="pk-well-score" style="color:${color}">${escapeHtml(String(d.score ?? ''))}</span>`;
    wl.appendChild(row);
  });

  const timelineSection = document.getElementById('packet-timeline-section');
  const tl = document.getElementById('packet-timeline');
  tl.innerHTML = '';
  timelineSection.style.display = (p.timeline || []).length ? '' : 'none';
  (p.timeline || []).forEach(s => {
    const li = document.createElement('li');
    li.textContent = s;
    tl.appendChild(li);
  });

  const ml = document.getElementById('packet-meds');
  ml.innerHTML = (p.medications || []).length
    ? p.medications.map(m => `<span class="pk-med">${escapeHtml(m)}</span>`).join('')
    : '<p class="pk-empty">None recorded in ClearChart.</p>';

  const ql = document.getElementById('packet-questions');
  ql.innerHTML = '';
  (p.questions || []).forEach(q => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="prep-check" aria-hidden="true"></span><span>${escapeHtml(q.question)}</span>`;
    ql.appendChild(li);
  });

  const cl = document.getElementById('packet-checklist');
  cl.innerHTML = '';
  (p.checklist || []).forEach(item => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="prep-check" aria-hidden="true"></span><span>${escapeHtml(item)}</span>`;
    cl.appendChild(li);
  });

  const citSection = document.getElementById('packet-citations-section');
  const cits = document.getElementById('packet-citations');
  cits.innerHTML = '';
  citSection.style.display = (p.citations || []).length ? '' : 'none';
  (p.citations || []).forEach(c => {
    const div = document.createElement('div');
    div.className = 'pk-citation';
    div.innerHTML = `<strong>${escapeHtml(c.source)}</strong>${c.url ? ` — <span class="prep-ref">${escapeHtml(c.url)}</span>` : ''}`;
    cits.appendChild(div);
  });

  if (p.disclaimer) {
    document.getElementById('packet-disclaimer').textContent =
      p.disclaimer + ' Bring your original lab report as well.';
  }

  showView('packet-view');
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
  const p = activeProfile();
  return [
    p.is_default ? '' : `This report belongs to the user's family member: ${p.name} (${p.relation}).`,
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

// ── MEDICATION REVIEW ─────────────────────────────────────
// The list is per profile: server-side for accounts, localStorage for guests.
// All label facts come from the backend's live openFDA/DailyMed retrieval.

const meds = { list: [], loaded: false, analyzing: false, searchTimer: null };

function localMedsKey() { return `clearchart-meds-${profileStore.activeId}`; }

async function showMeds(e) {
  if (e) e.preventDefault();
  showView('meds-view');
  renderProfileChip();
  if (meds.loaded) { renderMedChips(); return; }

  if (session.token) {
    try {
      const pid = profileStore.activeId ? `?profile_id=${encodeURIComponent(profileStore.activeId)}` : '';
      const res = await fetch(`${API_BASE}/medications${pid}`, { headers: authHeaders() });
      if (!res.ok) throw new Error();
      meds.list = (await res.json()).medications || [];
    } catch {
      meds.list = [];
      showToast('Could not load saved medications. Is the backend running?', 'error');
    }
  } else {
    try { meds.list = JSON.parse(localStorage.getItem(localMedsKey()) || '[]'); }
    catch { meds.list = []; }
  }
  meds.loaded = true;
  renderMedChips();
}

function renderMedChips() {
  const wrap = document.getElementById('med-chips');
  wrap.innerHTML = '';
  meds.list.forEach(m => {
    const chip = document.createElement('span');
    chip.className = 'med-chip';
    chip.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M10.5 20.5 3.5 13.5a5 5 0 0 1 7-7l7 7a5 5 0 0 1-7 7z"/><line x1="8.5" y1="8.5" x2="15.5" y2="15.5"/></svg>
      <span>${escapeHtml(m.name)}</span>
      <button aria-label="Remove ${escapeHtml(m.name)}" onclick="removeMedication('${escapeHtml(m.id)}')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>`;
    wrap.appendChild(chip);
  });
  document.getElementById('med-analyze-btn').disabled = meds.list.length === 0 || meds.analyzing;
}

function onMedInput() {
  clearTimeout(meds.searchTimer);
  const q = document.getElementById('med-input').value.trim();
  const box = document.getElementById('med-suggest');
  if (q.length < 2) { box.classList.remove('open'); return; }
  meds.searchTimer = setTimeout(async () => {
    try {
      const res = await fetch(`${API_BASE}/medications/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      const items = data.suggestions || [];
      if (!items.length) { box.classList.remove('open'); return; }
      box.innerHTML = items
        .map(s => `<button type="button" onclick="pickMedSuggestion(this)">${escapeHtml(s)}</button>`)
        .join('');
      box.classList.add('open');
    } catch { box.classList.remove('open'); }
  }, 300);
}

function pickMedSuggestion(btn) {
  document.getElementById('med-input').value = btn.textContent;
  document.getElementById('med-suggest').classList.remove('open');
  addMedication();
}

async function addMedication() {
  const input = document.getElementById('med-input');
  const name = input.value.trim();
  document.getElementById('med-suggest').classList.remove('open');
  if (name.length < 2) return;
  if (meds.list.some(m => m.name.toLowerCase() === name.toLowerCase())) {
    showToast(`${name} is already on the list`, 'info');
    return;
  }
  if (meds.list.length >= 12) { showToast('You can track up to 12 medications per profile.', 'error'); return; }

  if (session.token) {
    try {
      const res = await fetch(`${API_BASE}/medications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ name, profile_id: profileStore.activeId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Could not save the medication.');
      meds.list.push(data);
    } catch (err) {
      showToast(err.message, 'error');
      return;
    }
  } else {
    meds.list.push({ id: `local-${Date.now()}`, name });
    localStorage.setItem(localMedsKey(), JSON.stringify(meds.list));
  }

  input.value = '';
  renderMedChips();
  document.getElementById('med-results').innerHTML = '';   // list changed → stale analysis
}

async function removeMedication(id) {
  const med = meds.list.find(m => m.id === id);
  if (!med) return;

  if (session.token && !String(id).startsWith('local')) {
    try {
      const res = await fetch(`${API_BASE}/medications/${encodeURIComponent(id)}`, {
        method: 'DELETE', headers: authHeaders(),
      });
      if (!res.ok && res.status !== 404) throw new Error();
    } catch { showToast('Could not remove the medication.', 'error'); return; }
  }
  meds.list = meds.list.filter(m => m.id !== id);
  if (!session.token) localStorage.setItem(localMedsKey(), JSON.stringify(meds.list));
  renderMedChips();
  document.getElementById('med-results').innerHTML = '';
}

async function analyzeMedications() {
  if (meds.analyzing || meds.list.length === 0) return;
  meds.analyzing = true;
  const btn = document.getElementById('med-analyze-btn');
  btn.disabled = true;
  btn.querySelector('.btn-text').textContent = 'Checking FDA labels…';
  const results = document.getElementById('med-results');
  results.innerHTML = '';

  try {
    const res = await fetch(`${API_BASE}/medications/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ medications: meds.list.map(m => m.name) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Analysis failed. Please try again.');
    renderMedAnalysis(data);
  } catch (err) {
    const offline = err instanceof TypeError;
    results.innerHTML = `<div class="nutri-empty">${escapeHtml(offline
      ? 'Cannot reach the ClearChart server. Make sure the backend is running, then try again.'
      : err.message)}</div>`;
  } finally {
    meds.analyzing = false;
    btn.disabled = meds.list.length === 0;
    btn.querySelector('.btn-text').textContent = 'Check my medications';
  }
}

function medSourceLink(source) {
  if (!source) return '';
  return `<a class="citation-url" href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">Source: ${escapeHtml(source.label)}</a>`;
}

function renderMedAnalysis(data) {
  const results = document.getElementById('med-results');
  let html = '';

  if (data.overview) {
    html += `
      <div class="summary-card med-block">
        <h3 class="panel-section-title">Plain-English overview</h3>
        <p class="summary-text">${linkifyTerms(escapeHtml(data.overview))}</p>
        <p class="med-gloss-note">Simplified only from the label excerpts cited below — nothing added.</p>
      </div>`;
  }

  // Interactions between the listed medications
  if ((data.interactions || []).length) {
    html += `<div class="summary-card med-block">
      <h3 class="panel-section-title">Label-documented interactions</h3>
      ${data.interactions.map(i => `
        <div class="med-interaction">
          <p class="med-pair">${escapeHtml(i.pair[0])} <span aria-hidden="true">↔</span> ${escapeHtml(i.pair[1])}</p>
          <p class="med-excerpt">“${escapeHtml(i.excerpt)}”</p>
          ${medSourceLink(i.source)}
        </div>`).join('')}
    </div>`;
  } else {
    html += `<div class="summary-card med-block">
      <h3 class="panel-section-title">Interactions between your medications</h3>
      <p class="summary-text">No interaction between these medications is documented in their FDA labels. That is not a guarantee none exists — your pharmacist can run a complete check.</p>
    </div>`;
  }

  // Per-medication details
  (data.medications || []).forEach(m => {
    if (!m.found) {
      html += `<div class="summary-card med-block">
        <h3 class="panel-section-title">${escapeHtml(m.name)}</h3>
        <p class="summary-text">No authoritative FDA label was found for “${escapeHtml(m.name)}”. Check the spelling, try the generic name, or ask your pharmacist — we only show information we can source.</p>
      </div>`;
      return;
    }
    const s = m.sections || {};
    const row = (label, content) => content
      ? `<div class="med-row"><span class="med-row-label">${label}</span><p class="med-row-text">${linkifyTerms(escapeHtml(Array.isArray(content) ? content.join(' ') : content))}</p></div>`
      : '';
    const nothing = !s.side_effects && !s.food && !s.alcohol && !s.timing && !s.monitoring;
    html += `<div class="summary-card med-block">
      <h3 class="panel-section-title">${escapeHtml(m.name)}${m.generic_name && m.generic_name.toLowerCase() !== m.name.toLowerCase() ? ` <span class="med-generic">(${escapeHtml(m.generic_name.toLowerCase())})</span>` : ''}</h3>
      ${row('Common side effects', s.side_effects)}
      ${row('Food interactions', s.food)}
      ${row('Alcohol', s.alcohol)}
      ${row('Timing & how to take', s.timing)}
      ${row('Monitoring', s.monitoring)}
      ${nothing ? '<p class="summary-text">The label was found but these sections are empty for this product.</p>' : ''}
      ${medSourceLink(m.source)}
    </div>`;
  });

  if (data.note) {
    html += `<p class="med-note">${escapeHtml(data.note)}</p>`;
  }
  results.innerHTML = html;
}

// ── MEDICAL TERM POPOVERS ─────────────────────────────────
// A curated plain-English glossary; report text is linkified so terms open
// a popover on hover (desktop) or tap (mobile). Content is deliberately
// educational and generic — the report's own explanation stays primary.

const GLOSSARY = {
  hemoglobin: { name: 'Hemoglobin', tag: 'Blood', terms: ['hemoglobin', 'haemoglobin', 'hgb'],
    what: 'The protein in red blood cells that carries oxygen around your body.',
    why: 'Too little means your tissues get less oxygen, which causes tiredness and shortness of breath.',
    hilo: 'Low is the common concern (anemia). High is less common and can relate to smoking, altitude, or dehydration.',
    causes: 'Low: iron/B12/folate deficiency, blood loss, chronic disease. High: dehydration, lung conditions.',
    next: 'Doctors often check iron studies (ferritin), B12, and folate to find the cause.' },
  ferritin: { name: 'Ferritin', tag: 'Iron stores', terms: ['ferritin'],
    what: "A protein that stores iron — it's the best everyday measure of your iron reserves.",
    why: 'Iron reserves determine whether your body can make enough healthy red blood cells.',
    hilo: 'Low suggests iron deficiency even before anemia appears. High can reflect inflammation or iron overload.',
    causes: 'Low: diet, blood loss, absorption problems. High: inflammation, liver conditions, hereditary iron overload.',
    next: 'Often rechecked together with a full iron panel and CRP to rule out inflammation.' },
  anemia: { name: 'Anemia', tag: 'Condition', terms: ['anemia', 'anaemia', 'anemic'],
    what: 'Having fewer healthy red blood cells (or less hemoglobin) than your body needs.',
    why: 'It reduces oxygen delivery — fatigue, pale skin, and breathlessness are typical signs.',
    hilo: 'Anemia itself means values are low; the key question is why.',
    causes: 'Iron, B12, or folate deficiency; blood loss; chronic kidney disease; inherited conditions.',
    next: 'Doctors usually look for the cause with iron studies, B12/folate, and sometimes a stool test.' },
  ldl: { name: 'LDL cholesterol', tag: 'Lipids', terms: ['ldl'],
    what: 'The "bad" cholesterol — particles that can deposit cholesterol in artery walls.',
    why: 'Long-term high LDL is a major, treatable driver of heart attack and stroke risk.',
    hilo: 'High is the concern. Lower is generally better; there is no "too low" symptom for most people.',
    causes: 'Diet high in saturated fat, genetics, low thyroid, some medications.',
    next: 'Discussed alongside overall heart risk; options range from diet and exercise to statins.' },
  hdl: { name: 'HDL cholesterol', tag: 'Lipids', terms: ['hdl'],
    what: 'The "good" cholesterol — it carries cholesterol away from arteries back to the liver.',
    why: 'Higher HDL generally tracks with lower cardiovascular risk.',
    hilo: 'Low is the concern; high HDL is usually welcome.',
    causes: 'Low: inactivity, smoking, metabolic syndrome, genetics.',
    next: 'Exercise and stopping smoking are the classic HDL-raising conversation topics.' },
  triglycerides: { name: 'Triglycerides', tag: 'Lipids', terms: ['triglyceride', 'triglycerides'],
    what: 'The main form of fat circulating in your blood.',
    why: 'Very high levels raise cardiovascular risk and can inflame the pancreas.',
    hilo: 'High is the concern, especially after sugary or alcoholic intake.',
    causes: 'Added sugars, alcohol, uncontrolled diabetes, genetics.',
    next: 'Usually rechecked fasting; cutting sugar and alcohol is first-line.' },
  a1c: { name: 'Hemoglobin A1c', tag: 'Blood sugar', terms: ['hba1c', 'a1c'],
    what: 'Your average blood sugar over roughly the past three months.',
    why: "It shows the bigger picture that a single glucose reading can't.",
    hilo: '5.7–6.4% suggests pre-diabetes; 6.5%+ suggests diabetes. Low A1c is rarely a concern.',
    causes: 'High: insulin resistance, diabetes. Slightly off readings can also follow anemia.',
    next: 'Doctors discuss lifestyle changes and how often to re-test (typically every 3–6 months).' },
  glucose: { name: 'Glucose', tag: 'Blood sugar', terms: ['glucose'],
    what: 'The sugar your cells burn for energy, measured in your blood.',
    why: 'Persistently high fasting glucose is how pre-diabetes and diabetes are spotted early.',
    hilo: 'High (fasting 100–125 = pre-diabetic range) is the usual flag; low causes shakiness and sweating.',
    causes: 'High: insulin resistance, stress, some medications. Low: skipped meals, diabetes medication.',
    next: 'A repeat fasting test or an A1c usually confirms whether it is a pattern.' },
  creatinine: { name: 'Creatinine', tag: 'Kidney', terms: ['creatinine'],
    what: 'A waste product from muscles that healthy kidneys filter out of the blood.',
    why: "It's the standard quick check of how well your kidneys are filtering.",
    hilo: 'High suggests the kidneys are filtering less well. Low is rarely important.',
    causes: 'High: kidney strain, dehydration, some medications, very high muscle mass.',
    next: 'Interpreted together with eGFR; doctors may repeat it hydrated or add a urine test.' },
  egfr: { name: 'eGFR', tag: 'Kidney', terms: ['egfr', 'glomerular filtration'],
    what: 'Estimated filtration rate — how many millilitres of blood your kidneys clean per minute.',
    why: 'It stages kidney function; above 60 is generally considered adequate.',
    hilo: 'Low is the concern. There is no "too high".',
    causes: 'Low: chronic kidney disease, diabetes, high blood pressure, dehydration on test day.',
    next: 'If low, doctors usually recheck in weeks and look at urine protein.' },
  ast: { name: 'AST', tag: 'Liver', terms: ['ast', 'aspartate aminotransferase'],
    what: 'An enzyme found in the liver (and muscles) that leaks into blood when cells are stressed.',
    why: 'Raised levels can signal liver irritation — from fat, alcohol, viruses, or medications.',
    hilo: 'High is the concern; low is not meaningful.',
    causes: 'Fatty liver, alcohol, viral hepatitis, some medicines, intense exercise.',
    next: 'Usually interpreted with ALT; doctors may order an ultrasound or repeat after lifestyle changes.' },
  alt: { name: 'ALT', tag: 'Liver', terms: ['alt', 'alanine aminotransferase'],
    what: 'A liver enzyme — the most liver-specific of the standard panel.',
    why: 'Persistent elevation is an early flag for fatty liver and other liver conditions.',
    hilo: 'High is the concern; low is not meaningful.',
    causes: 'Fatty liver, alcohol, viral hepatitis, some medications and supplements.',
    next: 'Often rechecked after 4–8 weeks of reduced alcohol/sugar; imaging if it stays high.' },
  neutrophils: { name: 'Neutrophils', tag: 'Immune', terms: ['neutrophil', 'neutrophils', 'neutropenia'],
    what: 'The most numerous white blood cells — first responders against bacterial infection.',
    why: 'They show whether your immune system is fighting something or running low.',
    hilo: 'High often means infection or inflammation; low (neutropenia) weakens infection defence.',
    causes: 'High: infection, stress, steroids. Low: viral illness, some medications, chemotherapy.',
    next: 'Doctors look at the trend and the rest of the white-cell differential.' },
  wbc: { name: 'White blood cells', tag: 'Immune', terms: ['wbc', 'white blood cell', 'leukocyte', 'leukocytes'],
    what: 'Your immune cells as a group — the body\'s defence force.',
    why: 'The total count rises with infection and inflammation, and falls with some illnesses and drugs.',
    hilo: 'Both directions matter: high suggests the body is fighting; low weakens defences.',
    causes: 'High: infection, inflammation, stress. Low: viral infections, some medications.',
    next: 'The differential (which types are up or down) usually tells the real story.' },
  platelets: { name: 'Platelets', tag: 'Blood', terms: ['platelet', 'platelets', 'thrombocyte'],
    what: 'Tiny cell fragments that plug leaks — the first step of clotting.',
    why: 'Too few means easy bruising and bleeding; far too many can promote clots.',
    hilo: 'Both extremes matter, though mild deviations are common and often transient.',
    causes: 'Low: viral illness, some medicines, liver/spleen conditions. High: inflammation, iron deficiency.',
    next: 'Mild changes are usually just rechecked; the trend matters more than one value.' },
  tsh: { name: 'TSH', tag: 'Thyroid', terms: ['tsh', 'thyroid stimulating hormone'],
    what: "The pituitary's control signal to the thyroid — the best single thyroid screen.",
    why: 'It moves opposite to thyroid activity: high TSH usually means an underactive thyroid.',
    hilo: 'High TSH → underactive thyroid (fatigue, weight gain). Low TSH → overactive (palpitations, weight loss).',
    causes: 'Autoimmune thyroid disease is the most common cause in both directions.',
    next: 'Usually confirmed with free T4, and antibodies if autoimmune disease is suspected.' },
  vitamind: { name: 'Vitamin D', tag: 'Vitamin', terms: ['vitamin d', '25-oh', 'calcidiol'],
    what: 'A hormone-like vitamin your skin makes from sunlight; key for bones and muscles.',
    why: 'Deficiency is extremely common and quietly affects bone strength and energy.',
    hilo: 'Low is the near-universal concern; toxicity from supplements is rare but real.',
    causes: 'Low: limited sun, darker skin at high latitudes, malabsorption.',
    next: 'Doctors discuss dosing and when to re-test (often ~3 months).' },
  b12: { name: 'Vitamin B12', tag: 'Vitamin', terms: ['b12', 'cobalamin'],
    what: 'A vitamin needed for red blood cells and healthy nerves, found mostly in animal foods.',
    why: 'Deficiency causes anemia and — if prolonged — nerve symptoms like tingling.',
    hilo: 'Low is the concern; high usually just reflects supplements.',
    causes: 'Low: vegetarian/vegan diet, absorption problems, long-term antacid or metformin use.',
    next: 'Doctors ask about diet and medications, and may test absorption-related markers.' },
  bilirubin: { name: 'Bilirubin', tag: 'Liver', terms: ['bilirubin'],
    what: 'A yellow pigment from recycling old red blood cells, cleared by the liver.',
    why: 'High levels cause jaundice and can point to liver or bile-duct issues.',
    hilo: 'High is the flag; mildly high alone is often harmless Gilbert syndrome.',
    causes: 'Gilbert syndrome, liver conditions, bile-duct blockage, rapid red-cell breakdown.',
    next: 'Interpreted with the other liver tests; direct vs indirect fractions narrow the cause.' },
  potassium: { name: 'Potassium', tag: 'Electrolyte', terms: ['potassium'],
    what: 'An electrolyte critical for heart rhythm and muscle function.',
    why: 'Both high and low levels can disturb heart rhythm — this one has a narrow safe band.',
    hilo: 'Both directions matter and deserve a prompt conversation if flagged.',
    causes: 'Low: diuretics, vomiting/diarrhea. High: kidney issues, some blood-pressure medications.',
    next: 'Often rechecked promptly to rule out a sample artifact before acting.' },
  sodium: { name: 'Sodium', tag: 'Electrolyte', terms: ['sodium', 'natremia'],
    what: 'The main electrolyte controlling water balance in your body.',
    why: 'Abnormal sodium usually reflects water balance, not salt intake.',
    hilo: 'Low is more common (medications, overhydration); both extremes affect the brain.',
    causes: 'Low: diuretics, hormonal issues, excess water. High: dehydration.',
    next: 'Doctors review medications and fluid intake first.' },
  calcium: { name: 'Calcium', tag: 'Electrolyte', terms: ['calcium', 'calcemia'],
    what: 'A mineral for bones, nerves, and muscle — tightly regulated in blood.',
    why: 'Persistent abnormalities often trace to parathyroid or vitamin D issues.',
    hilo: 'High: often parathyroid-related. Low: vitamin D deficiency is a common cause.',
    causes: 'High: hyperparathyroidism, some cancers. Low: vitamin D deficiency, kidney disease.',
    next: 'Usually rechecked with albumin, vitamin D, and PTH.' },
  uricacid: { name: 'Uric acid', tag: 'Metabolic', terms: ['uric acid', 'urate'],
    what: 'A waste product from purines (in meat, seafood, beer) cleared by the kidneys.',
    why: 'High levels can crystallise in joints — that is gout.',
    hilo: 'High is the concern; low is rarely meaningful.',
    causes: 'Diet, alcohol, kidney clearance, diuretics, genetics.',
    next: 'Hydration and diet first; medication if gout attacks occur.' },
  albumin: { name: 'Albumin', tag: 'Protein', terms: ['albumin'],
    what: 'The main protein in blood, made by the liver; it holds fluid in your vessels.',
    why: 'Low albumin can reflect liver trouble, kidney losses, inflammation, or poor nutrition.',
    hilo: 'Low is the flag; high usually just means dehydration.',
    causes: 'Liver disease, kidney protein loss, chronic inflammation, low intake.',
    next: 'Interpreted with liver and kidney panels to find the source.' },
  hyperlipidemia: { name: 'Hyperlipidemia', tag: 'Condition', terms: ['hyperlipidemia', 'hyperlipidaemia', 'dyslipidemia'],
    what: 'The umbrella term for having too much cholesterol and/or triglycerides in the blood.',
    why: 'It is a silent but very treatable contributor to heart attack and stroke risk.',
    hilo: 'It describes values being high by definition.',
    causes: 'Diet, genetics, low thyroid, diabetes, some medications.',
    next: 'Doctors weigh overall cardiovascular risk to choose between lifestyle change and medication.' },
  hypertension: { name: 'Hypertension', tag: 'Condition', terms: ['hypertension', 'high blood pressure'],
    what: 'Blood pressure that stays above the healthy range (roughly 130/80 and up).',
    why: 'Over years it quietly damages heart, brain, kidneys, and eyes — and it is very treatable.',
    hilo: 'High is the definition; the number pair (systolic/diastolic) both matter.',
    causes: 'Genetics, salt, weight, alcohol, sleep apnea, kidney or hormonal conditions.',
    next: 'Home readings over a week or two usually guide the treatment conversation.' },
  crp: { name: 'CRP', tag: 'Inflammation', terms: ['crp', 'c-reactive protein'],
    what: 'A protein the liver releases when there is inflammation anywhere in the body.',
    why: 'It is a sensitive but non-specific smoke detector — it says "something", not "what".',
    hilo: 'High is the flag; the higher it is, the more active the inflammation.',
    causes: 'Infections, autoimmune flares, injury; mildly high with obesity and smoking.',
    next: 'Doctors pair it with symptoms and other tests to locate the source.' },
};

// One flat lookup: term (lowercase) → glossary key, longest terms first so
// "vitamin d" wins over "d", etc.
const _TERM_INDEX = [];
for (const [key, entry] of Object.entries(GLOSSARY)) {
  for (const t of entry.terms) _TERM_INDEX.push([t.toLowerCase(), key]);
}
_TERM_INDEX.sort((a, b) => b[0].length - a[0].length);
const _TERM_RE = new RegExp(
  `\\b(${_TERM_INDEX.map(([t]) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'gi'
);

/* Wrap known medical terms in an already-HTML-escaped string with popover
   triggers. Call ONLY on escaped text. */
function linkifyTerms(escapedText) {
  let count = 0;
  return escapedText.replace(_TERM_RE, (match) => {
    if (count >= 12) return match;              // don't turn prose into confetti
    const hit = _TERM_INDEX.find(([t]) => t === match.toLowerCase());
    if (!hit) return match;
    count++;
    return `<button type="button" class="term" data-term="${hit[1]}">${match}</button>`;
  });
}

let _termPop = null;
let _termHideTimer = null;

function ensureTermPopover() {
  if (_termPop) return _termPop;
  _termPop = document.createElement('div');
  _termPop.id = 'term-pop';
  _termPop.setAttribute('role', 'tooltip');
  document.body.appendChild(_termPop);
  _termPop.addEventListener('mouseenter', () => clearTimeout(_termHideTimer));
  _termPop.addEventListener('mouseleave', scheduleTermHide);
  return _termPop;
}

function showTermPopover(target) {
  const entry = GLOSSARY[target.dataset.term];
  if (!entry) return;
  clearTimeout(_termHideTimer);
  const pop = ensureTermPopover();

  pop.innerHTML = `
    <div class="tp-head">
      <span class="tp-name">${escapeHtml(entry.name)}</span>
      <span class="tp-tag">${escapeHtml(entry.tag)}</span>
    </div>
    <div class="tp-row"><span class="tp-label">What it is</span><p>${escapeHtml(entry.what)}</p></div>
    <div class="tp-row"><span class="tp-label">Why it matters</span><p>${escapeHtml(entry.why)}</p></div>
    <div class="tp-row"><span class="tp-label">High vs low</span><p>${escapeHtml(entry.hilo)}</p></div>
    <div class="tp-row"><span class="tp-label">Common causes</span><p>${escapeHtml(entry.causes)}</p></div>
    <div class="tp-row"><span class="tp-label">Often discussed next</span><p>${escapeHtml(entry.next)}</p></div>
    <p class="tp-foot">Educational only — your report and your doctor come first.</p>`;

  pop.classList.add('open');
  const rect = target.getBoundingClientRect();
  const popW = Math.min(330, window.innerWidth - 24);
  pop.style.width = popW + 'px';
  let left = rect.left + rect.width / 2 - popW / 2;
  left = Math.max(12, Math.min(left, window.innerWidth - popW - 12));
  pop.style.left = left + 'px';

  const popH = pop.offsetHeight;
  const below = rect.bottom + 10;
  pop.style.top = (below + popH > window.innerHeight - 10 && rect.top - popH - 10 > 0
    ? rect.top - popH - 10
    : below) + window.scrollY + 'px';
  pop.style.position = 'absolute';
}

function scheduleTermHide() {
  clearTimeout(_termHideTimer);
  _termHideTimer = setTimeout(() => { if (_termPop) _termPop.classList.remove('open'); }, 180);
}

document.addEventListener('mouseover', (e) => {
  const term = e.target.closest('.term');
  if (term) showTermPopover(term);
});
document.addEventListener('mouseout', (e) => {
  if (e.target.closest('.term')) scheduleTermHide();
});
document.addEventListener('click', (e) => {
  const term = e.target.closest('.term');
  if (term) { showTermPopover(term); clearTimeout(_termHideTimer); return; }
  if (_termPop && !e.target.closest('#term-pop')) _termPop.classList.remove('open');
});
document.addEventListener('focusin', (e) => {
  const term = e.target.closest('.term');
  if (term) showTermPopover(term);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && _termPop) _termPop.classList.remove('open');
});
window.addEventListener('scroll', () => { if (_termPop) _termPop.classList.remove('open'); }, { passive: true });

// ── "EXPLAIN THIS VALUE" DRAWER ───────────────────────────
// Assembled from data the app ALREADY has: the finding itself (rule-engine
// validated), the curated GLOSSARY, the profile's medication list, and
// guideline citations retrieved by the backend's existing RAG index.
// Nothing is generated: missing pieces say so instead of guessing.

/* Structural metadata only (which biomarkers relate to which) — the medical
   content itself stays in GLOSSARY. Keys are GLOSSARY keys. */
const RELATED_BIOMARKERS = {
  ldl: ['hdl', 'triglycerides', 'a1c'], hdl: ['ldl', 'triglycerides'],
  triglycerides: ['ldl', 'hdl', 'glucose'], hyperlipidemia: ['ldl', 'hdl', 'triglycerides'],
  glucose: ['a1c'], a1c: ['glucose'],
  hemoglobin: ['ferritin', 'b12', 'platelets'], ferritin: ['hemoglobin', 'crp'],
  anemia: ['hemoglobin', 'ferritin', 'b12'], b12: ['hemoglobin'],
  creatinine: ['egfr', 'albumin', 'potassium'], egfr: ['creatinine'],
  ast: ['alt', 'bilirubin', 'albumin'], alt: ['ast', 'bilirubin', 'albumin'],
  bilirubin: ['ast', 'alt'], albumin: ['creatinine', 'alt'],
  tsh: [], vitamind: ['calcium'], calcium: ['vitamind', 'albumin'],
  potassium: ['sodium', 'creatinine'], sodium: ['potassium'],
  wbc: ['neutrophils', 'crp'], neutrophils: ['wbc'], platelets: ['hemoglobin'],
  uricacid: ['creatinine'], crp: ['wbc', 'ferritin'], hypertension: ['creatinine', 'sodium'],
};

/* Which listed medications are worth mentioning for a value. Name patterns
   only — the "why" is deliberately generic and non-prescriptive. */
const MED_RELEVANCE = [
  { params: /ldl|hdl|triglycerid|cholesterol/i, meds: /statin$|atorva|rosuva|simva|prava|lova|ezetimibe|fenofibrate|niacin/i, why: 'commonly used in cholesterol management' },
  { params: /glucose|a1c|sugar/i, meds: /metformin|insulin|glipizide|glimepiride|gliclazide|sitagliptin|empagliflozin|dapagliflozin|semaglutide|liraglutide/i, why: 'affects blood-sugar values' },
  { params: /tsh|thyroid/i, meds: /levothyroxine|methimazole|carbimazole|liothyronine/i, why: 'directly changes thyroid test values' },
  { params: /potassium|sodium|creatinine|egfr|urea|bun/i, meds: /lisinopril|enalapril|ramipril|losartan|valsartan|telmisartan|spironolactone|furosemide|hydrochlorothiazide|ibuprofen|naproxen|diclofenac/i, why: 'can influence kidney function and electrolytes' },
  { params: /alt|ast|bilirubin|liver|alkaline/i, meds: /acetaminophen|paracetamol|statin|atorva|rosuva|simva|methotrexate|isoniazid|amiodarone/i, why: 'can affect liver enzyme values' },
  { params: /uric|urate/i, meds: /allopurinol|febuxostat|hydrochlorothiazide|aspirin/i, why: 'changes uric acid levels' },
  { params: /hemoglobin|ferritin|b12|folate/i, meds: /omeprazole|pantoprazole|esomeprazole|metformin|aspirin|warfarin|clopidogrel/i, why: 'can influence blood counts or vitamin absorption over time' },
];

function glossaryKeyFor(parameter) {
  const name = (parameter || '').toLowerCase();
  const hit = _TERM_INDEX.find(([t]) => name.includes(t));
  return hit ? hit[1] : null;
}

async function ensureMedsList() {
  if (meds.loaded) return meds.list;
  if (!session.token) {
    try { return JSON.parse(localStorage.getItem(localMedsKey()) || '[]'); } catch { return []; }
  }
  try {
    const pid = profileStore.activeId ? `?profile_id=${encodeURIComponent(profileStore.activeId)}` : '';
    const res = await fetch(`${API_BASE}/medications${pid}`, { headers: authHeaders() });
    if (!res.ok) return [];
    meds.list = (await res.json()).medications || [];
    meds.loaded = true;
    return meds.list;
  } catch { return []; }
}

function exSection(title, html) {
  return html ? `<div class="ex-section"><h4 class="ex-section-title">${title}</h4>${html}</div>` : '';
}

function exText(text) {
  return text ? `<p class="ex-text">${escapeHtml(text)}</p>` : '';
}

function openExplain(f) {
  const key = glossaryKeyFor(f.parameter);
  const g = key ? GLOSSARY[key] : null;

  document.getElementById('ex-title').textContent = g ? g.name : (f.parameter || 'This value');
  document.getElementById('ex-tag').textContent = g ? g.tag : 'Lab value';

  const statusClass = { high: 'chip-high', low: 'chip-low', abnormal: 'chip-abnormal', normal: 'chip-normal' }[(f.status || '').toLowerCase()] || '';
  const rangeText = f.reference_range
    || (f.ref_low !== undefined && f.ref_high !== undefined && f.ref_high < 9000 ? `${fmt(f.ref_low)}–${fmt(f.ref_high)}${f.unit ? ' ' + f.unit : ''}` : '');

  let html = '';

  // Your value — reuses the report's own comparison chart
  if (f.value || f.numeric_value !== undefined) {
    html += `<div class="ex-section">
      <h4 class="ex-section-title">Your value</h4>
      <div class="ex-value-row">
        <span class="ex-value">${escapeHtml(f.value || fmt(f.numeric_value))}</span>
        ${f.status ? `<span class="status-chip ${statusClass}">${escapeHtml(f.status.toUpperCase())}</span>` : ''}
        ${rangeText ? `<span class="finding-ref">Healthy: ${escapeHtml(rangeText)}</span>` : ''}
      </div>
      ${renderComparisonBar(f)}
    </div>`;
  }

  if (g) {
    html += exSection('What it measures', exText(g.what));
    html += exSection('Why clinicians monitor it', exText(g.why));
    html += exSection('High vs low', exText(g.hilo));
    html += exSection('Common causes', exText(g.causes));
    html += exSection('Often discussed next', exText(g.next));
  } else {
    html += exSection('Plain-language entry', '<p class="ex-text ex-muted">No curated plain-language entry exists for this biomarker yet — the sections below show what your report and the guideline index say.</p>');
  }

  if (f.explanation) {
    html += exSection('In your report', exText(f.explanation));
  }

  // Related biomarkers (chips open the matching finding when it's in this report)
  const related = (key && RELATED_BIOMARKERS[key]) || [];
  if (related.length) {
    html += exSection('Related biomarkers', `<div class="ex-related">${related
      .filter(k => GLOSSARY[k])
      .map(k => `<button type="button" class="ex-rel-chip" data-rel="${k}">${escapeHtml(GLOSSARY[k].name)}</button>`)
      .join('')}</div>`);
  }

  html += exSection('Your medications', '<p class="ex-text ex-muted" id="ex-meds">Checking your medication list…</p>');
  html += exSection('Clinical guidelines', '<p class="ex-text ex-muted" id="ex-citations">Looking up guideline passages…</p>');
  html += '<p class="ex-foot">Educational only — your report and your doctor come first.</p>';

  const body = document.getElementById('ex-body');
  body.innerHTML = html;
  body.scrollTop = 0;

  body.querySelectorAll('.ex-rel-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const relKey = chip.dataset.rel;
      const inReport = (state.lastReport?.findings || []).find(x => glossaryKeyFor(x.parameter) === relKey);
      openExplain(inReport || { parameter: GLOSSARY[relKey].name });
    });
  });

  document.getElementById('explain-overlay').classList.add('open');
  document.getElementById('explain-drawer').classList.add('open');
  document.getElementById('explain-drawer').focus();

  fillExplainMeds(f);
  fillExplainCitations(f.parameter);
}

async function fillExplainMeds(f) {
  const el = document.getElementById('ex-meds');
  if (!el) return;
  const list = await ensureMedsList();
  if (!document.getElementById('ex-meds')) return;   // drawer content replaced meanwhile
  if (!list.length) {
    el.textContent = 'No medications on this profile’s list. You can add them under Medications.';
    return;
  }
  const rule = MED_RELEVANCE.find(r => r.params.test(f.parameter || ''));
  const relevant = rule ? list.filter(m => rule.meds.test(m.name)) : [];
  if (relevant.length) {
    el.classList.remove('ex-muted');
    el.innerHTML = relevant.map(m => `<span class="pk-med">${escapeHtml(m.name)}</span>`).join(' ')
      + `<span class="ex-med-why"> — ${escapeHtml(rule.why)}. Mention it when discussing this value.</span>`;
  } else {
    el.textContent = 'None of your listed medications are commonly linked to this value.';
  }
}

async function fillExplainCitations(parameter) {
  const el = document.getElementById('ex-citations');
  if (!el) return;
  try {
    const res = await fetch(`${API_BASE}/explain?q=${encodeURIComponent(parameter || '')}`);
    if (!res.ok) throw new Error();
    const cits = (await res.json()).citations || [];
    if (!document.getElementById('ex-citations')) return;
    if (!cits.length) {
      el.textContent = 'No guideline passages found for this biomarker in the knowledge base.';
      return;
    }
    el.classList.remove('ex-muted');
    el.outerHTML = cits.map(c => `
      <div class="ex-citation">
        <p class="citation-source">${escapeHtml(c.source || '')}</p>
        <p class="ex-cite-passage">“${escapeHtml(c.passage || '')}”</p>
        ${c.url ? `<a class="citation-url" href="${escapeHtml(c.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(c.url)}</a>` : ''}
      </div>`).join('');
  } catch {
    el.textContent = 'Guideline lookup is unavailable right now — the rest of this explanation still applies.';
  }
}

function closeExplain() {
  document.getElementById('explain-overlay').classList.remove('open');
  document.getElementById('explain-drawer').classList.remove('open');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeExplain();
});

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
