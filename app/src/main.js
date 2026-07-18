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
  format: 'webp', // fast + tiny WASM by default; AVIF/Auto are opt-in
  maxEdge: 0,
  effort: null, // null = auto (fast search / small final per format)
  renamePattern: '',
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
  wireModal();
  pool.warm('webp'); // prime the HTTP cache + compile the default codec on one worker while the user picks a file
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
    document.querySelectorAll('#mode button').forEach((b) => { b.classList.toggle('on', b === btn); b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'); });
    document.querySelectorAll('[data-for]').forEach((el) => { el.hidden = el.dataset.for !== state.mode; });
  });
  $('#targetKB').addEventListener('input', (e) => (state.targetKB = Number(e.target.value) || 1));
  $('#format').addEventListener('change', (e) => {
    state.format = e.target.value;
    // prime the chosen codec(s) so the next compress doesn't wait on a WASM fetch.
    // One worker each: enough to warm the HTTP cache without a herd of cold compiles.
    if (state.format === 'auto') { pool.warm('avif'); pool.warm('webp'); pool.warm('jpeg'); }
    else if (state.format !== 'png') pool.warm(state.format);
  });
  $('#resize').addEventListener('change', (e) => (state.maxEdge = Number(e.target.value) || 0));
  const effort = $('#effort'), effortVal = $('#effortVal');
  effort.addEventListener('input', (e) => {
    state.effort = Number(e.target.value);
    effortVal.textContent = String(state.effort);
  });
  effort.addEventListener('dblclick', () => { state.effort = null; effortVal.textContent = 'auto'; });
  $('#clearAll').addEventListener('click', clearAll);
  $('#renamePattern').addEventListener('input', (e) => { state.renamePattern = e.target.value; applyRename(); });
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
    s.setProperty('--accent', '#2fd08c'); s.setProperty('--accent-strong', '#2fd08c'); s.setProperty('--accent-bright', '#4ee0a3'); s.setProperty('--accent-ink', '#0c1510'); s.setProperty('--accent-wash', '#16261e');
  } else {
    s.setProperty('--paper', '#f6f4ee'); s.setProperty('--paper-2', '#efece3'); s.setProperty('--card', '#fffdf8');
    s.setProperty('--ink', '#1a1815'); s.setProperty('--ink-70', '#4a463f'); s.setProperty('--ink-45', '#6d685c');
    s.setProperty('--line', '#e2ddd1'); s.setProperty('--line-2', '#d3cdbf');
    s.setProperty('--accent', '#0f9d6b'); s.setProperty('--accent-strong', '#0b7d54'); s.setProperty('--accent-bright', '#17c281'); s.setProperty('--accent-ink', '#ffffff'); s.setProperty('--accent-wash', '#e7f4ee');
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
    let best, candidates;
    if (auto) {
      // Run the formats in PARALLEL across workers (not sequentially in one),
      // so Auto takes about as long as its slowest format instead of the sum.
      const formats = ['avif', 'webp', 'jpeg'];
      const settled = await Promise.all(formats.map((f) =>
        pool.run(buf.slice(0), file.type, { ...opts, format: f }).catch((e) => ({ error: e.message }))
      ));
      const ok = settled.filter((r) => !r.error);
      if (!ok.length) throw new Error(settled[0]?.error || 'Compression failed');
      const met = ok.filter((r) => r.targetMet !== false);
      best = (met.length ? met : ok).reduce((a, b) => (a.size <= b.size ? a : b));
      candidates = ok.slice().sort((a, b) => a.size - b.size);
    } else {
      best = await pool.run(buf, file.type, { ...opts, format: opts.format });
      candidates = [best];
    }
    const entry = { name: file.name, best };
    done.push(entry);
    renderResult(card, file, best, candidates, entry);
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

function renderResult(pendingCard, file, best, candidates, entry) {
  const tpl = $('#cardTpl').content.cloneNode(true);
  const root = tpl.querySelector('.card');
  const el = (r) => root.querySelector(`[data-role="${r}"]`);
  const beforeUrl = URL.createObjectURL(file);
  let outUrl = null;

  // paint() fills the card from a result, and can be re-run when the user tunes.
  const paint = (res, cands) => {
    if (outUrl) URL.revokeObjectURL(outUrl);
    outUrl = URL.createObjectURL(new Blob([res.bytes], { type: res.mime }));
    const pct = Math.round((1 - res.ratio) * 100);
    el('before').src = beforeUrl;
    el('after').src = outUrl;
    el('name').textContent = file.name;
    el('badge').textContent = res.label;
    el('newSize').textContent = fmtSize(res.size);
    el('saved').textContent = pct >= 0 ? `${pct}%` : `+${-pct}%`;
    el('score').textContent = String(res.score);
    el('meter').style.width = `${Math.max(2, res.score)}%`;
    el('meta').textContent = `${res.width}×${res.height} · ${res.note}` + (cands && cands.length > 1 ? ' · ' + cands.map((c) => `${c.label} ${fmtSize(c.size)}`).join('  ') : '');
    const w = el('warn');
    const warns = [];
    if (res.grewLargerThanSource) warns.push('Larger than your original; it was already well optimised, so keep the original.');
    if (res.targetMet === false) warns.push('This format could not reach that fidelity. Try AVIF.');
    if (warns.length) { w.hidden = false; w.textContent = '⚠ ' + warns.join(' '); } else { w.hidden = true; }
    const dl = el('download');
    dl.href = outUrl;
    dl.download = file.name.replace(/\.[^.]+$/, '') + '.' + res.ext;
  };

  entry.el = root;
  entry.repaint = paint; // so a tune-apply can re-render this exact card
  paint(best, candidates);
  el('tune').addEventListener('click', () => openTune(file, entry.best, (tuned) => { entry.best = tuned; paint(tuned, [tuned]); applyRename(); refreshSummary(); }));

  pendingCard.replaceWith(root);
  wireCompare(root.querySelector('.cmp'));
  applyRename();
}

/** Compute an output filename for an entry, honouring the rename pattern. */
function computeName(entry, i) {
  const base = entry.name.replace(/\.[^.]+$/, '');
  const ext = entry.best.ext;
  const p = state.renamePattern.trim();
  const stem = p ? p.replace(/\{n\}/g, String(i + 1)).replace(/\{name\}/g, base) : base;
  return `${stem}.${ext}`;
}

/** Push current filenames onto every card's download link. */
function applyRename() {
  done.forEach((e, i) => {
    const a = e.el?.querySelector('[data-role="download"]');
    if (a) a.download = computeName(e, i);
  });
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

// --- precision tuning modal -------------------------------------------------

const TUNE_FORMATS = [
  { id: 'avif', label: 'AVIF' }, { id: 'webp', label: 'WebP' },
  { id: 'jpeg', label: 'JPEG' }, { id: 'png', label: 'PNG' },
];
let tuneCtx = null; // { file, onApply, format, quality, last }

function openTune(file, current, onApply) {
  const modal = $('#tune');
  const q = parseInt((current.note || '').replace(/\D/g, ''), 10);
  tuneCtx = { file, onApply, format: current.format, quality: Number.isFinite(q) ? q : 75, last: current };

  $('#tuneTitle').textContent = file.name;
  $('#tuneCmp [data-role="before"]').src = URL.createObjectURL(file);
  paintTune(current);

  // format tabs
  const box = $('#tuneFormats'); box.textContent = '';
  for (const f of TUNE_FORMATS) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'tune-fmt' + (f.id === tuneCtx.format ? ' on' : '');
    b.textContent = f.label; b.dataset.id = f.id;
    b.addEventListener('click', () => { tuneCtx.format = f.id; document.querySelectorAll('.tune-fmt').forEach((e) => e.classList.toggle('on', e.dataset.id === f.id)); reflectPngState(); scheduleProbe(); });
    box.appendChild(b);
  }
  const slider = $('#tuneQ');
  slider.value = String(tuneCtx.quality);
  $('#tuneQVal').textContent = String(tuneCtx.quality);
  reflectPngState();

  tuneCtx.opener = document.activeElement; // restore focus here on close
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  (modal.querySelector('.icon-btn') || slider).focus();
}

// Keep Tab focus inside the open modal (basic focus trap).
function trapFocus(e) {
  const modal = $('#tune');
  if (modal.hidden || e.key !== 'Tab') return;
  const f = [...modal.querySelectorAll('button, [href], input, select, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && el.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function reflectPngState() {
  $('#tuneQualityBox').classList.toggle('off', tuneCtx.format === 'png');
}

function paintTune(res) {
  const url = URL.createObjectURL(new Blob([res.bytes], { type: res.mime }));
  $('#tuneCmp [data-role="after"]').src = url;
  const pct = Math.round((1 - res.ratio) * 100);
  $('#tuneSize').textContent = fmtSize(res.size);
  $('#tuneSaved').textContent = pct >= 0 ? `${pct}%` : `+${-pct}%`;
  $('#tuneScore').textContent = res.format === 'png' ? '100' : String(res.score);
  tuneCtx.last = res;
}

let probeTimer = null;
function scheduleProbe() {
  clearTimeout(probeTimer);
  probeTimer = setTimeout(runProbe, 180);
}
async function runProbe() {
  if (!tuneCtx) return;
  const busy = $('#tuneBusy'); busy.hidden = false;
  try {
    const buf = await tuneCtx.file.arrayBuffer();
    const res = await pool.probe(buf, tuneCtx.file.type, {
      format: tuneCtx.format, quality: tuneCtx.quality,
      maxEdge: state.maxEdge || undefined, effort: state.effort ?? undefined,
    });
    if (tuneCtx) paintTune(res);
  } catch (err) {
    console.error(err);
  } finally {
    busy.hidden = true;
  }
}

function wireModal() {
  const modal = $('#tune');
  modal.addEventListener('click', (e) => { if (e.target.dataset.close !== undefined) closeTune(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeTune(); trapFocus(e); });
  const slider = $('#tuneQ');
  slider.addEventListener('input', (e) => { tuneCtx.quality = Number(e.target.value); $('#tuneQVal').textContent = e.target.value; scheduleProbe(); });
  $('#tuneApply').addEventListener('click', () => { if (tuneCtx?.last) tuneCtx.onApply(tuneCtx.last); closeTune(); });
  wireCompare($('#tuneCmp'));
}
function closeTune() {
  $('#tune').hidden = true;
  document.body.style.overflow = '';
  tuneCtx?.opener?.focus?.(); // restore focus to the Tune button
  tuneCtx = null;
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
  $('#renameWrap').hidden = done.length < 1;
  const dl = $('#downloadAll');
  dl.hidden = done.length < 2;
  dl.onclick = downloadAll;
}

function downloadAll() {
  const taken = new Set();
  const tree = {};
  done.forEach((d, i) => {
    let name = computeName(d, i);
    const base = name.replace(/\.[^.]+$/, ''), ext = d.best.ext;
    let n = 2;
    while (taken.has(name)) name = `${base}-${n++}.${ext}`;
    taken.add(name);
    tree[name] = [new Uint8Array(d.best.bytes.slice(0)), { level: 0 }];
  });
  tree['README.txt'] = [strToU8('Compressed with ShrinkRay. https://github.com/mfahadiqbalofcl/shrinkray\n'), { level: 6 }];
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
