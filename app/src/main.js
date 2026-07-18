/**
 * ShrinkRay browser app — controller. Wires the Studio UI to the worker pool.
 * Everything runs on the device; no network calls beyond loading the app itself.
 */
import { getPool } from './engine/pool.js';
import { zipSync, strToU8 } from 'fflate';

const $ = (s, r = document) => r.querySelector(s);
const results = $('#results');
const pool = getPool();

const state = {
  mode: 'quality',
  preset: 'balanced',
  target: 'balanced',
  targetKB: 200,
  format: 'auto',
  maxEdge: 0,
  effort: null, // null = auto (fast search / small final per format)
};

const PRESETS = [
  { id: 'balanced', title: 'Balanced', sub: 'Great for web', cfg: { mode: 'quality', target: 'balanced' } },
  { id: 'high', title: 'High', sub: 'Barely touched', cfg: { mode: 'quality', target: 'high' } },
  { id: 'small', title: 'Small', sub: 'Lightest, still good', cfg: { mode: 'quality', target: 'small' } },
  { id: 'lossless', title: 'Lossless', sub: 'No pixels change', cfg: { mode: 'quality', target: 'lossless', format: 'png' } },
];

const done = []; // { name, best } for finished results (for download-all + summary)

init();

function init() {
  buildPresets();
  bindControls();
  bindDrop();
  bindTheme();
}

// --- controls ---------------------------------------------------------------

function buildPresets() {
  const box = $('#presets');
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'preset' + (p.id === state.preset ? ' on' : '');
    b.dataset.id = p.id;
    const t = document.createElement('span'); t.className = 'pt'; t.textContent = p.title;
    const s = document.createElement('span'); s.className = 'ps'; s.textContent = p.sub;
    b.append(t, s);
    b.addEventListener('click', () => applyPreset(p));
    box.appendChild(b);
  }
}

function applyPreset(p) {
  state.preset = p.id;
  Object.assign(state, p.cfg);
  document.querySelectorAll('.preset').forEach((el) => el.classList.toggle('on', el.dataset.id === p.id));
  if (p.cfg.format) $('#format').value = p.cfg.format;
}

function bindControls() {
  $('#mode').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    state.mode = btn.dataset.mode;
    document.querySelectorAll('#mode button').forEach((b) => b.classList.toggle('on', b === btn));
    document.querySelectorAll('[data-for]').forEach((el) => { el.hidden = el.dataset.for !== state.mode; });
  });
  $('#targetKB').addEventListener('input', (e) => (state.targetKB = Number(e.target.value) || 1));
  $('#format').addEventListener('change', (e) => (state.format = e.target.value));
  $('#resize').addEventListener('change', (e) => (state.maxEdge = Number(e.target.value) || 0));
  const effort = $('#effort'), effortVal = $('#effortVal');
  effort.addEventListener('input', (e) => {
    state.effort = Number(e.target.value);
    effortVal.textContent = String(state.effort);
  });
  effort.addEventListener('dblclick', () => { state.effort = null; effortVal.textContent = 'auto'; });
  $('#clearAll').addEventListener('click', clearAll);
}

function bindTheme() {
  const root = document.documentElement;
  const saved = localStorage.getItem('sr-theme');
  if (saved) { root.dataset.theme = saved; applyThemeVars(saved); }
  const btn = $('#theme');
  const sync = () => (btn.textContent = current() === 'dark' ? '☀' : '☾');
  const current = () => root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  btn.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next; localStorage.setItem('sr-theme', next); sync();
    applyThemeVars(next);
  });
  sync();
}
// data-theme overrides the media query
function applyThemeVars(theme) {
  const s = document.documentElement.style;
  if (theme === 'dark') {
    s.setProperty('--paper', '#16150f'); s.setProperty('--paper-2', '#100f0a'); s.setProperty('--card', '#201e17');
    s.setProperty('--ink', '#f4f1e8'); s.setProperty('--ink-70', '#c7c2b4'); s.setProperty('--ink-45', '#8f897a');
    s.setProperty('--line', '#322f26'); s.setProperty('--line-2', '#413d31');
    s.setProperty('--accent', '#2fd08c'); s.setProperty('--accent-bright', '#4ee0a3'); s.setProperty('--accent-ink', '#0c1510'); s.setProperty('--accent-wash', '#16261e');
  } else {
    s.setProperty('--paper', '#f6f4ee'); s.setProperty('--paper-2', '#efece3'); s.setProperty('--card', '#fffdf8');
    s.setProperty('--ink', '#1a1815'); s.setProperty('--ink-70', '#4a463f'); s.setProperty('--ink-45', '#837d72');
    s.setProperty('--line', '#e2ddd1'); s.setProperty('--line-2', '#d3cdbf');
    s.setProperty('--accent', '#0f9d6b'); s.setProperty('--accent-bright', '#17c281'); s.setProperty('--accent-ink', '#fffdf8'); s.setProperty('--accent-wash', '#e7f4ee');
  }
}

// --- drop / input -----------------------------------------------------------

function bindDrop() {
  const drop = $('#drop'), file = $('#file');
  $('#browse').addEventListener('click', (e) => { e.stopPropagation(); file.click(); });
  drop.addEventListener('click', () => file.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } });
  file.addEventListener('change', () => { handleFiles([...file.files]); file.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'dragleave' && drop.contains(e.relatedTarget)) return; drop.classList.remove('drag'); }));
  drop.addEventListener('drop', (e) => handleFiles([...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'))));
  window.addEventListener('paste', (e) => { const f = [...(e.clipboardData?.files || [])].filter((x) => x.type.startsWith('image/')); if (f.length) handleFiles(f); });
}

function currentOpts() {
  return {
    format: state.format === 'auto' ? undefined : state.format,
    mode: state.mode,
    target: state.mode === 'quality' ? state.target : undefined,
    targetKB: state.mode === 'size' ? state.targetKB : undefined,
    maxEdge: state.maxEdge || undefined,
    effort: state.effort ?? undefined,
  };
}

async function handleFiles(files) {
  if (!files.length) return;
  const opts = currentOpts();
  await Promise.all(files.map((file) => compressOne(file, opts)));
  refreshSummary();
}

async function compressOne(file, opts) {
  const card = renderPending(file.name);
  try {
    const buf = await file.arrayBuffer();
    const auto = !opts.format;
    const res = auto
      ? await pool.runAuto(buf, file.type, { ...opts, formats: ['avif', 'webp', 'jpeg'] })
      : await pool.run(buf, file.type, { ...opts, format: opts.format });
    const best = auto ? res.best : res;
    const candidates = auto ? res.candidates : [res];
    renderResult(card, file, best, candidates);
    done.push({ name: file.name, best });
  } catch (err) {
    renderError(card, file.name, err.message);
  }
}

// --- rendering --------------------------------------------------------------

function renderPending(name) {
  const card = document.createElement('article');
  card.className = 'card pending';
  const sp = document.createElement('span'); sp.className = 'spinner';
  const wrap = document.createElement('div');
  const nm = document.createElement('div'); nm.className = 'pending-name'; nm.textContent = name;
  const sub = document.createElement('div'); sub.className = 'pending-sub'; sub.textContent = 'finding the smallest file…';
  wrap.append(nm, sub);
  card.append(sp, wrap);
  results.prepend(card);
  return card;
}

function renderError(card, name, msg) {
  card.className = 'card error';
  card.textContent = '';
  const wrap = document.createElement('div');
  const nm = document.createElement('div'); nm.className = 'pending-name'; nm.textContent = name;
  const sub = document.createElement('div'); sub.className = 'pending-sub'; sub.textContent = msg;
  wrap.append(nm, sub);
  card.append(wrap);
}

function renderResult(card, file, best, candidates) {
  const tpl = $('#cardTpl').content.cloneNode(true);
  const root = tpl.querySelector('.card');
  const el = (r) => tpl.querySelector(`[data-role="${r}"]`);
  const pct = Math.round((1 - best.ratio) * 100);
  const outBlob = new Blob([best.bytes], { type: best.mime });
  const outUrl = URL.createObjectURL(outBlob);

  el('before').src = URL.createObjectURL(file);
  el('after').src = outUrl;
  el('name').textContent = file.name;
  el('badge').textContent = best.label;
  el('newSize').textContent = fmtSize(best.size);
  el('saved').textContent = pct >= 0 ? `${pct}%` : `+${-pct}%`;
  el('score').textContent = String(best.score);
  el('meter').style.width = `${Math.max(2, best.score)}%`;
  el('meta').textContent = `${best.width}×${best.height} · ${best.note} · ${candidates.map((c) => `${c.label} ${fmtSize(c.size)}`).join('  ')}`;

  const warns = [];
  if (best.grewLargerThanSource) warns.push('Larger than your original — it was already well optimised, so keep the original.');
  if (best.targetMet === false) warns.push(state.mode === 'size' ? 'Could not reach that size even after downscaling; this is the smallest.' : 'This format could not reach that fidelity. Try AVIF.');
  if (warns.length) { const w = el('warn'); w.hidden = false; w.textContent = '⚠ ' + warns.join(' '); }

  const dl = el('download');
  dl.href = outUrl;
  dl.download = file.name.replace(/\.[^.]+$/, '') + '.' + best.ext;

  card.replaceWith(root);
  wireCompare(root.querySelector('.cmp'));
}

function wireCompare(cmp) {
  if (!cmp) return;
  const set = (clientX) => {
    const r = cmp.getBoundingClientRect();
    cmp.style.setProperty('--pos', `${Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100))}%`);
  };
  let dragging = false;
  const start = (e) => { dragging = true; set((e.touches?.[0] || e).clientX); e.preventDefault(); };
  const move = (e) => { if (dragging) set((e.touches?.[0] || e).clientX); };
  cmp.addEventListener('mousedown', start);
  cmp.addEventListener('touchstart', start, { passive: false });
  window.addEventListener('mousemove', move);
  window.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('mouseup', () => (dragging = false));
  window.addEventListener('touchend', () => (dragging = false));
  cmp.addEventListener('mousemove', (e) => { if (!dragging) set(e.clientX); });
}

// --- summary + download all -------------------------------------------------

function refreshSummary() {
  const summary = $('#summary');
  if (!done.length) { summary.classList.remove('show'); return; }
  summary.classList.add('show');
  const totalIn = done.reduce((a, d) => a + d.best.originalSize, 0);
  const totalOut = done.reduce((a, d) => a + d.best.size, 0);
  const pct = totalIn ? Math.round((1 - totalOut / totalIn) * 100) : 0;
  $('#summaryBig').innerHTML = `<span class="accent">${pct}%</span> smaller`;
  $('#summarySub').textContent = `${done.length} image${done.length > 1 ? 's' : ''} · ${fmtSize(totalIn)} → ${fmtSize(totalOut)}`;
  const dl = $('#downloadAll');
  dl.hidden = done.length < 2;
  dl.onclick = downloadAll;
}

function downloadAll() {
  const taken = new Set();
  const tree = {};
  for (const d of done) {
    let name = d.name.replace(/\.[^.]+$/, '') + '.' + d.best.ext;
    let n = 2;
    while (taken.has(name)) name = d.name.replace(/\.[^.]+$/, '') + `-${n++}.` + d.best.ext;
    taken.add(name);
    tree[name] = [new Uint8Array(d.best.bytes.slice(0)), { level: 0 }];
  }
  tree['README.txt'] = [strToU8('Compressed with ShrinkRay — https://github.com/mfahadiqbalofcl/shrinkray\n'), { level: 6 }];
  const zip = zipSync(tree);
  const url = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'shrinkray-images.zip';
  document.body.appendChild(a); a.click(); a.remove();
}

function clearAll() {
  done.length = 0;
  results.textContent = '';
  refreshSummary();
}

function fmtSize(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}
