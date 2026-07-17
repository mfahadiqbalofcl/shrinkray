// ShrinkRay client. Talks to the local server, renders result cards, drives the
// before/after slider. No dependencies, no build step — just an ES module.

const $ = (sel, root = document) => root.querySelector(sel);
const results = $('#results');
const drop = $('#drop');
const fileInput = $('#file');

let FORMATS = [];
let state = {
  mode: 'quality',
  target: 'high',
  targetKB: 100,
  format: 'auto',
  effort: 4,
  maxEdge: null,
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

init();

async function init() {
  bindControls();
  bindDropzone();
  bindTheme();
  try {
    const res = await fetch('/api/formats');
    const data = await res.json();
    FORMATS = data.formats;
    populateFormats(data.formats);
    const jxl = data.formats.some((f) => f.id === 'jxl');
    $('#engineInfo').textContent = `sharp/libvips · ${data.formats.map((f) => f.label).join(' · ')}${jxl ? '' : ''}`;
  } catch {
    $('#engineInfo').textContent = 'engine offline — is the server running?';
  }
}

function populateFormats(formats) {
  const sel = $('#format');
  for (const f of formats) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = `${f.label} only`;
    sel.appendChild(opt);
  }
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function bindControls() {
  document.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
      state.mode = btn.dataset.mode;
      document.querySelectorAll('.mode-body').forEach((mb) => mb.classList.toggle('hidden', mb.dataset.for !== state.mode));
    });
  });

  $('#target').addEventListener('change', (e) => (state.target = e.target.value));
  $('#targetKB').addEventListener('input', (e) => (state.targetKB = Number(e.target.value) || 1));
  $('#format').addEventListener('change', (e) => {
    state.format = e.target.value;
    syncEffortRange();
  });
  $('#effort').addEventListener('input', (e) => {
    state.effort = Number(e.target.value);
    $('#effortVal').textContent = state.effort;
  });
  $('#maxEdge').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    state.maxEdge = v > 0 ? v : null;
  });
}

// Each format has its own effort scale; clamp the slider to the active one.
function syncEffortRange() {
  const slider = $('#effort');
  const f = FORMATS.find((x) => x.id === state.format);
  const [min, max] = f?.effortRange || [0, 9];
  const def = f?.defaultEffort ?? 4;
  slider.min = min;
  slider.max = max;
  if (state.effort < min || state.effort > max) {
    state.effort = def;
    slider.value = def;
    $('#effortVal').textContent = def;
  }
}

// ---------------------------------------------------------------------------
// Dropzone / input
// ---------------------------------------------------------------------------

function bindDropzone() {
  $('#browse').addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  fileInput.addEventListener('change', () => { handleFiles([...fileInput.files]); fileInput.value = ''; });

  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('dragging'); })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'dragleave' && drop.contains(e.relatedTarget)) return; drop.classList.remove('dragging'); })
  );
  drop.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) handleFiles(files);
  });

  // Paste an image from the clipboard.
  window.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) handleFiles(files);
  });
}

const isZipFile = (f) => /\.zip$/i.test(f.name) || f.type === 'application/zip' || f.type === 'application/x-zip-compressed';

async function handleFiles(files) {
  const zips = files.filter(isZipFile);
  const images = files.filter((f) => !isZipFile(f));

  // A dropped ZIP is a batch of its own; images are compressed together.
  for (const zip of zips) await compressBatch([zip], { zip: true });
  if (images.length) await compressBatch(images, { zip: false });
}

/** Build the multipart form for a compress request. */
function buildForm(files) {
  const fd = new FormData();
  fd.append('mode', state.mode);
  fd.append('format', state.format);
  if (state.mode === 'quality') fd.append('target', state.target);
  else fd.append('targetKB', String(state.targetKB));
  fd.append('effort', String(state.effort));
  if (state.maxEdge) fd.append('maxEdge', String(state.maxEdge));
  for (const f of files) fd.append('image', f, f.name);
  return fd;
}

/**
 * POST files and consume the server's NDJSON progress stream. Loose images get
 * a result card each as they finish; a ZIP gets the batch panel + a download.
 */
async function compressBatch(files, { zip }) {
  // Keep object URLs so result cards can show the "before" image.
  const originals = new Map(files.map((f) => [f.name, f]));

  const res = await fetch('/api/compress', { method: 'POST', body: buildForm(files) });
  if (!res.ok || !res.body) {
    const msg = await res.json().catch(() => ({}));
    throw new Error(msg.error || `Server error ${res.status}`);
  }

  const cards = new Map(); // name -> pending card element (loose mode)
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handleEvent(JSON.parse(line), { zip, originals, cards });
    }
  }
}

function handleEvent(ev, ctx) {
  switch (ev.type) {
    case 'start':
      if (ctx.zip || ev.total > 1) showBatch(ev);
      break;
    case 'result': // loose image finished
      if (ev.ok) {
        const file = ctx.originals.get(ev.name);
        renderResult(renderPending(ev.name), file, { name: ev.name, best: ev.best });
      } else {
        renderError(renderPending(ev.name), ev.name, ev.error);
      }
      bumpBatchLoose(ctx.originals.size);
      break;
    case 'progress': // zip image finished (no preview)
      updateBatch(ev);
      break;
    case 'done':
      finishBatch(ev, ctx);
      break;
    case 'error':
      failBatch(ev.error);
      break;
  }
}

// ---------------------------------------------------------------------------
// Batch panel (ZIPs and multi-image runs)
// ---------------------------------------------------------------------------

const batchEl = $('#batch');
let batchDone = 0;

function showBatch(ev) {
  batchDone = 0;
  batchEl.classList.remove('hidden');
  $('#batchTitle').textContent = ev.isZip ? 'Compressing ZIP…' : `Compressing ${ev.total} images…`;
  $('#batchCount').textContent = `0 / ${ev.total}`;
  $('#batchBar').style.width = '0%';
  $('#batchFoot').textContent = ev.skipped ? `${ev.skipped} non-image file(s) will be skipped` : '';
  const dl = $('#batchDownload');
  dl.classList.add('hidden');
  dl.removeAttribute('href');
}

function updateBatch(ev) {
  batchDone = ev.done;
  $('#batchCount').textContent = `${ev.done} / ${ev.total}`;
  $('#batchBar').style.width = `${Math.round((ev.done / ev.total) * 100)}%`;
}

function bumpBatchLoose(total) {
  if (batchEl.classList.contains('hidden')) return;
  batchDone++;
  $('#batchCount').textContent = `${batchDone} / ${total}`;
  $('#batchBar').style.width = `${Math.round((batchDone / total) * 100)}%`;
}

function finishBatch(ev, ctx) {
  if (batchEl.classList.contains('hidden')) return; // single image, no panel
  const s = ev.stats || {};
  $('#batchBar').style.width = '100%';
  $('#batchTitle').textContent = ctx.zip ? 'ZIP compressed' : 'Done';
  $('#batchCount').textContent = `${s.compressed} / ${s.images}`;
  const saved = s.percentSaved ?? 0;
  $('#batchFoot').innerHTML =
    `${fmtSize(s.totalIn)} → <span class="big">${fmtSize(s.totalOut)}</span> · ${saved}% smaller` +
    (s.failed ? ` · ${s.failed} failed` : '') +
    (s.skipped ? ` · ${s.skipped} skipped` : '');
  const dl = $('#batchDownload');
  if (ev.downloadId) {
    dl.href = `/api/download/${ev.downloadId}`;
    dl.textContent = ctx.zip ? '↓ Download ZIP' : '↓ Download all as ZIP';
    dl.classList.remove('hidden');
  }
}

function failBatch(message) {
  if (batchEl.classList.contains('hidden')) return;
  $('#batchTitle').textContent = 'Failed';
  $('#batchFoot').textContent = message;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderPending(name) {
  const card = document.createElement('article');
  card.className = 'card pending';
  card.innerHTML = `<div class="pending-row"><span class="spinner"></span><span><span class="pending-name">${escapeHtml(name)}</span> — finding the smallest file…</span></div>`;
  results.prepend(card);
  return card;
}

function renderError(card, name, message) {
  card.className = 'card error';
  card.innerHTML = `<div class="pending-row"><span style="color:var(--danger);font-weight:700">✕</span><span><span class="pending-name">${escapeHtml(name)}</span> — ${escapeHtml(message)}</span></div>`;
}

function renderResult(pendingCard, file, entry) {
  const tpl = $('#cardTpl').content.cloneNode(true);
  const cardEl = tpl.querySelector('.card'); // the template's own <article.card>
  const el = (role) => tpl.querySelector(`[data-role="${role}"]`);
  const best = entry.best;

  // The "before" image is the local file (loose uploads). ZIP-sourced results
  // have no local File, so fall back to comparing against the compressed image.
  el('before').src = file ? URL.createObjectURL(file) : best.dataUrl;
  el('after').src = best.dataUrl;

  el('name').textContent = entry.name;
  el('name').title = entry.name;
  el('format').textContent = best.label;

  el('newSize').textContent = fmtSize(best.size);
  el('saved').textContent = best.percentSaved >= 0 ? `${best.percentSaved}%` : `+${-best.percentSaved}%`;
  el('score').textContent = `${best.score}`;
  el('meter').style.width = `${Math.max(2, best.score)}%`;

  el('meta').textContent = `${best.width}×${best.height} · ${best.note} · DSSIM ${best.dssim.toExponential(2)}`;
  el('origSize').textContent = `was ${fmtSize(best.originalSize)}`;

  // Honest warnings.
  const warn = el('warn');
  const warns = [];
  if (best.grewLargerThanSource) warns.push('This is larger than your original — the source is already well-optimised. Keep the original.');
  if (best.targetMet === false) {
    warns.push(state.mode === 'size'
      ? "Couldn't reach that size even after downscaling — this is the smallest it goes."
      : 'This format could not reach that fidelity. Try AVIF for the best shot at it.');
  }
  if (warns.length) { warn.classList.remove('hidden'); warn.textContent = '⚠ ' + warns.join(' '); }

  // Candidate chips (auto mode compares formats).
  const cands = el('candidates');
  if (entry.candidates && entry.candidates.length > 1) {
    for (const c of entry.candidates) {
      const chip = document.createElement('span');
      chip.className = 'cand' + (c.format === best.format ? ' best' : '');
      chip.textContent = `${c.label} ${fmtSize(c.size)}`;
      cands.appendChild(chip);
    }
  }

  // Download.
  const dl = el('download');
  const base = entry.name.replace(/\.[^.]+$/, '');
  dl.href = best.dataUrl;
  dl.download = `${base}.${best.ext}`;
  dl.innerHTML = `↓ Download .${best.ext}`;

  // Replace the pending placeholder with the finished card (no nesting).
  pendingCard.replaceWith(cardEl);
  wireCompare(cardEl.querySelector('.compare'));
}

// ---------------------------------------------------------------------------
// Before/after slider
// ---------------------------------------------------------------------------

function wireCompare(compare) {
  if (!compare) return;
  const setPos = (clientX) => {
    const rect = compare.getBoundingClientRect();
    const pct = Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100));
    compare.style.setProperty('--pos', `${pct}%`);
  };
  let dragging = false;
  const start = (e) => { dragging = true; setPos((e.touches?.[0] || e).clientX); e.preventDefault(); };
  const move = (e) => { if (dragging) setPos((e.touches?.[0] || e).clientX); };
  const end = () => { dragging = false; };

  compare.addEventListener('mousedown', start);
  compare.addEventListener('touchstart', start, { passive: false });
  window.addEventListener('mousemove', move);
  window.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('mouseup', end);
  window.addEventListener('touchend', end);
  // Hover-to-scrub on desktop for a frictionless first impression.
  compare.addEventListener('mousemove', (e) => { if (!dragging) setPos(e.clientX); });
}

// ---------------------------------------------------------------------------
// Theme + utils
// ---------------------------------------------------------------------------

function bindTheme() {
  const root = document.documentElement;
  const saved = localStorage.getItem('shrinkray-theme');
  if (saved) root.dataset.theme = saved;
  $('#themeToggle').addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    localStorage.setItem('shrinkray-theme', next);
    $('#themeToggle').textContent = next === 'dark' ? '☾' : '☀';
  });
  $('#themeToggle').textContent = root.dataset.theme === 'dark' ? '☾' : '☀';
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
