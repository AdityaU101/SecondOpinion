/* ─────────────────────────────────────────────────────────
   ClearChart — shared site logic (theme + auth session)
   Loaded by every page: index.html, login.html, app.html
   ───────────────────────────────────────────────────────── */

const CC_API = 'http://localhost:8000/api/v1';

/* ── THEME ────────────────────────────────────────────────
   The <head> of each page runs a tiny inline snippet that sets
   data-theme before first paint (no flash). This file owns the
   toggle behaviour + persistence. */

function ccGetTheme() {
  const saved = localStorage.getItem('clearchart-theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function ccApplyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

function ccToggleTheme() {
  const next = ccGetTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem('clearchart-theme', next);

  // brief cross-fade so the swap feels intentional, not jarring
  const root = document.documentElement;
  root.classList.add('theme-fade');
  ccApplyTheme(next);
  setTimeout(() => root.classList.remove('theme-fade'), 400);
}

// Follow OS changes only when the user hasn't picked a side.
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!localStorage.getItem('clearchart-theme')) ccApplyTheme(ccGetTheme());
  });
}

/* ── SCROLL REVEAL ────────────────────────────────────────
   Sections marked [data-reveal] fade in as they enter the
   viewport. Without IO support or with reduced motion on,
   .reveal-ready is never added and everything renders visible. */

(function () {
  const els = document.querySelectorAll('[data-reveal]');
  if (!els.length || !('IntersectionObserver' in window)) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  document.documentElement.classList.add('reveal-ready');
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('revealed');
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -40px' });
  els.forEach((el) => io.observe(el));
})();

/* ── AUTH SESSION ─────────────────────────────────────────── */

function ccGetSession() {
  try {
    const raw = localStorage.getItem('clearchart-session');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function ccSetSession(session) {
  localStorage.setItem('clearchart-session', JSON.stringify(session));
}

function ccLogout() {
  localStorage.removeItem('clearchart-session');
  window.location.href = 'login.html';
}

function ccInitials(name) {
  return (name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map(w => w[0])
    .join('')
    .toUpperCase();
}
