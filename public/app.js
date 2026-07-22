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
    $('#engineInfo').textContent = 'engine offline. Is the server running?';
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
  // Resize preset and the custom Advanced field both drive state.maxEdge and
  // stay in sync so they never disagree.
  $('#resize').addEventListener('change', (e) => {
    const v = Number(e.target.value);
    state.maxEdge = v > 0 ? v : null;
    $('#maxEdge').value = v > 0 ? v : '';
  });
  $('#maxEdge').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    state.maxEdge = v > 0 ? v : null;
    // reflect a custom value in the preset dropdown (or clear it)
    $('#resize').value = [0, 4000, 2560, 1920, 1280].includes(v) ? String(v) : '0';
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
    const files = [...(e.dataTransfer?.files || [])].filter(acceptable);
    if (files.length) handleFiles(files);
  });

  // Paste an image from the clipboard.
  window.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter(acceptable);
    if (files.length) handleFiles(files);
  });
}

// Accept images and ZIP archives (a ZIP has no image/* MIME type).
const acceptable = (f) => f.type.startsWith('image/') || isZipFile(f);

const isZipFile = (f) => /\.zip$/i.test(f.name) || f.type === 'application/zip' || f.type === 'application/x-zip-compressed';

async function handleFiles(files) {
  const zips = files.filter(isZipFile);
  const images = files.filter((f) => !isZipFile(f));
  for (const zip of zips) await runZip(zip); // each ZIP is its own streamed batch
  if (images.length) await runLoose(images); // loose images compress together
}

function settingsParams() {
  const p = new URLSearchParams();
  p.set('mode', state.mode);
  p.set('format', state.format);
  if (state.mode === 'quality') p.set('target', state.target);
  else p.set('targetKB', String(state.targetKB));
  p.set('effort', String(state.effort));
  if (state.maxEdge) p.set('maxEdge', String(state.maxEdge));
  return p;
}

const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB per chunk
const UPLOAD_CONCURRENCY = 4; // chunks in flight at once
const CHUNK_RETRIES = 4;

/**
 * XHR POST with a real upload-progress callback plus an incremental NDJSON
 * response reader. fetch() cannot report upload progress, so loose-image
 * uploads use this. (Large ZIPs use the chunked uploader below instead.)
 */
function streamPost(url, body, onUpload, onEvent, headers = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onUpload(e.loaded, e.total); };
    xhr.upload.onload = () => onUpload(-1, -1); // signal: upload body fully sent

    let cursor = 0;
    const drain = () => {
      const text = xhr.responseText;
      let nl;
      while ((nl = text.indexOf('\n', cursor)) >= 0) {
        const line = text.slice(cursor, nl).trim();
        cursor = nl + 1;
        if (line) { try { onEvent(JSON.parse(line)); } catch { /* partial line */ } }
      }
    };
    xhr.onprogress = drain;
    xhr.onload = () => { drain(); (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(new Error(safeErr(xhr) || `Server error ${xhr.status}`)); };
    xhr.onerror = () => reject(new Error('Network error. Is the server running?'));
    xhr.send(body);
  });
}

function safeErr(xhr) { try { return JSON.parse(xhr.responseText).error; } catch { return null; } }

/** PUT one chunk, with retries. Resolves once the server has stored it. */
function putChunk(id, offset, blob) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const send = () => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `/api/upload/chunk/${id}?offset=${offset}`);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else if (++attempt < CHUNK_RETRIES) setTimeout(send, 250 * attempt);
        else reject(new Error(safeErr(xhr) || `Chunk failed (${xhr.status})`));
      };
      xhr.onerror = () => { if (++attempt < CHUNK_RETRIES) setTimeout(send, 250 * attempt); else reject(new Error('Chunk upload failed')); };
      xhr.send(blob);
    };
    send();
  });
}

/**
 * Upload a file in parallel chunks. A dropped chunk is retried on its own
 * instead of restarting the whole upload, and `onProgress(loaded, total)` fires
 * as chunks land. Returns the server upload id once every chunk is stored.
 */
async function chunkedUpload(file, onProgress) {
  const initRes = await fetch('/api/upload/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: file.name, size: file.size }),
  });
  if (!initRes.ok) throw new Error((await initRes.json().catch(() => ({}))).error || 'Could not start upload');
  const { id } = await initRes.json();

  // Build the list of chunk offsets, then run them through a small worker pool.
  const offsets = [];
  for (let o = 0; o < file.size; o += CHUNK_SIZE) offsets.push(o);
  let uploaded = 0;
  let next = 0;
  const worker = async () => {
    while (next < offsets.length) {
      const offset = offsets[next++];
      const blob = file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size));
      await putChunk(id, offset, blob);
      uploaded += blob.size;
      onProgress(uploaded, file.size);
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, offsets.length) }, worker));
  return id;
}

/** Read an NDJSON response stream (no upload body) via fetch. */
async function fetchStream(url, onEvent) {
  const res = await fetch(url, { method: 'POST' });
  if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || `Server error ${res.status}`);
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
      if (line) onEvent(JSON.parse(line));
    }
  }
}

/** Any ZIP: chunked resumable upload, then process, with staged UI. */
async function runZip(zip) {
  const b = beginBatch({ zip: true, title: zip.name });
  try {
    const id = await chunkedUpload(zip, (loaded, total) => b.onUpload(loaded, total));
    b.onUpload(-1, -1); // upload done
    await fetchStream(`/api/upload/process/${id}?${settingsParams().toString()}`, (ev) => b.onEvent(ev));
  } catch (err) {
    b.fail(err.message);
  }
}

/** Loose images: multipart upload + per-image result cards. */
async function runLoose(images) {
  const fd = new FormData();
  for (const [k, v] of settingsParams()) fd.append(k, v);
  for (const f of images) fd.append('image', f, f.name);
  const originals = new Map(images.map((f) => [f.name, f]));
  const b = beginBatch({ zip: false, title: `${images.length} image${images.length > 1 ? 's' : ''}`, showPanel: images.length > 1, originals });
  await streamPost('/api/compress', fd, (l, t) => b.onUpload(l, t), (ev) => b.onEvent(ev)).catch((err) => b.fail(err.message));
}

/**
 * Trigger a browser download that streams to disk (works for any file size).
 * Checks the result is still available first (a HEAD request) so an expired
 * result shows a clear message instead of downloading an error page.
 */
async function triggerDownload(url, filename) {
  try {
    const head = await fetch(url, { method: 'HEAD' });
    if (!head.ok) return false;
  } catch { return false; }
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  return true;
}

// ---------------------------------------------------------------------------
// Staged batch panel — one controller per run
// ---------------------------------------------------------------------------

const batchEl = $('#batch');
const STEP_ORDER = ['upload', 'read', 'compress', 'package', 'ready'];

function beginBatch({ zip, title, showPanel = true, originals }) {
  const st = { zip, panel: showPanel, total: 0, done: 0, startCompress: 0, uploadStart: performance.now(), originals };
  if (showPanel) {
    batchEl.classList.remove('hidden');
    $('#batchTitle').textContent = `Compressing ${title}`;
    $('#batchCount').textContent = '';
    $('#batchFoot').textContent = '';
    $('#batchEta').textContent = '';
    $('#batchBar').style.width = '0%';
    indeterminate(false);
    const dl = $('#batchDownload'); dl.classList.add('hidden'); dl.onclick = null;
    for (const s of STEP_ORDER) { setStep(s, ''); setStepNote(s, ''); }
    stepEl('read').style.display = zip ? '' : 'none';
    stepEl('package').style.display = zip ? '' : 'none';
    setStep('upload', 'active');
  }
  return {
    onUpload(loaded, total) {
      if (!st.panel) return;
      if (loaded === -1) { // upload done
        setStep('upload', 'done', 'sent');
        setStep(zip ? 'read' : 'compress', 'active');
        indeterminate(true);
        $('#batchEta').textContent = '';
        return;
      }
      indeterminate(false);
      const pct = total ? loaded / total : 0;
      $('#batchBar').style.width = `${Math.round(pct * 100)}%`;
      setStepNote('upload', `${fmtSize(loaded)} / ${fmtSize(total)}`);
      const secs = (performance.now() - st.uploadStart) / 1000;
      const mbps = secs > 0 ? loaded / 1024 / 1024 / secs : 0;
      $('#batchEta').textContent = mbps > 0 ? `${mbps.toFixed(1)} MB/s` : '';
    },
    onEvent(ev) { handleBatchEvent(ev, st); },
    fail(msg) {
      if (!st.panel) { renderError(renderPending('upload'), 'Upload', msg); return; }
      indeterminate(false);
      $('#batchTitle').textContent = 'Failed';
      const active = STEP_ORDER.find((s) => stepEl(s).classList.contains('active'));
      if (active) setStep(active, '', '✕');
      $('#batchFoot').textContent = msg;
    },
  };
}

function handleBatchEvent(ev, st) {
  switch (ev.type) {
    case 'uploaded':
      setStep('upload', 'done', fmtSize(ev.size));
      break;
    case 'stage':
      if (ev.stage === 'reading') {
        setStep('read', 'active');
        indeterminate(true);
        // Show the archive being scanned so a big ZIP reads as "working", not stuck.
        const scanned = ev.scanned || 0;
        setStepNote('read', scanned ? `${scanned} entries…` : 'opening…');
        $('#batchFoot').textContent = scanned ? `Reading archive — ${scanned} entries scanned…` : 'Reading archive…';
      } else if (ev.stage === 'packaging') { setStep('compress', 'done'); setStep('package', 'active'); indeterminate(true); $('#batchEta').textContent = ''; $('#batchFoot').textContent = 'Packaging your ZIP…'; }
      break;
    case 'start':
      st.total = ev.total; st.startCompress = performance.now();
      setStep('read', 'done', `${ev.total} image${ev.total !== 1 ? 's' : ''}${ev.skipped ? ` · ${ev.skipped} skipped` : ''}`);
      setStep('compress', 'active');
      indeterminate(false);
      $('#batchCount').textContent = `0 / ${ev.total}`;
      $('#batchFoot').textContent = 'Compressing…';
      break;
    case 'ping': // heartbeat during a long encode — keep the UI alive
      if (st.panel && stepEl('compress').classList.contains('active') && ev.name) {
        setStepNote('compress', `${st.done} / ${st.total || '?'}`);
        $('#batchFoot').textContent = `Working on ${baseName(ev.name)}…`;
      }
      break;
    case 'result': // loose image finished (with preview)
      if (st.panel) { st.done++; updateCompress(st); }
      if (ev.ok) renderResult(renderPending(ev.name), st.originals?.get(ev.name), { name: ev.name, best: ev.best });
      else renderError(renderPending(ev.name), ev.name, ev.error);
      break;
    case 'progress': // zip image finished
      st.done = ev.done; st.total = ev.total; st.lastIn = ev.totalIn; st.lastOut = ev.totalOut;
      updateCompress(st);
      break;
    case 'done':
      finishBatch(ev, st);
      break;
    case 'error':
      if (st.panel) { indeterminate(false); $('#batchTitle').textContent = 'Failed'; $('#batchFoot').textContent = ev.error; }
      break;
  }
}

function updateCompress(st) {
  if (!st.panel || !st.total) return;
  indeterminate(false);
  $('#batchBar').style.width = `${Math.round((st.done / st.total) * 100)}%`;
  $('#batchCount').textContent = `${st.done} / ${st.total}`;
  setStepNote('compress', `${st.done} / ${st.total}`);
  if (st.lastIn) $('#batchFoot').innerHTML = `${fmtSize(st.lastIn)} → <span class="big">${fmtSize(st.lastOut)}</span> so far`;
  const secs = (performance.now() - st.startCompress) / 1000;
  if (secs > 1 && st.done > 0) {
    const rate = st.done / secs;
    const remain = (st.total - st.done) / rate;
    $('#batchEta').textContent = remain > 0.5 ? `~${fmtTime(remain)} left · ${rate.toFixed(1)}/s` : '';
  }
}

function finishBatch(ev, st) {
  if (!st.panel) return;
  const s = ev.stats || {};
  for (const step of STEP_ORDER) setStep(step, 'done');
  indeterminate(false);
  $('#batchBar').style.width = '100%';
  $('#batchTitle').textContent = st.zip ? 'ZIP ready' : 'Done';
  $('#batchCount').textContent = `${s.compressed ?? st.done} / ${s.images ?? st.total}`;
  setStepNote('ready', 'done');
  $('#batchFoot').innerHTML =
    `${fmtSize(s.totalIn)} → <span class="big">${fmtSize(s.totalOut)}</span> · ${s.percentSaved ?? 0}% smaller` +
    (s.failed ? ` · ${s.failed} failed` : '') + (s.skipped ? ` · ${s.skipped} skipped` : '');
  $('#batchEta').textContent = '';

  const dl = $('#batchDownload');
  if (ev.downloadId) {
    const url = `/api/download/${ev.downloadId}`;
    const filename = st.zip ? 'shrinkray-compressed.zip' : 'shrinkray-images.zip';
    dl.textContent = st.zip ? '↓ Download ZIP' : '↓ Download all as ZIP';
    dl.classList.remove('hidden');
    dl.onclick = async () => {
      const ok = await triggerDownload(url, filename);
      if (!ok) { $('#batchFoot').textContent = 'That result expired. Please compress again.'; dl.classList.add('hidden'); }
    };
    // Auto-start the download so the file is saved without hunting for a button.
    // (The button stays as a fallback if the browser blocks the automatic one.)
    triggerDownload(url, filename);
  }
}

// step + bar helpers
function stepEl(name) { return batchEl.querySelector(`.step[data-step="${name}"]`); }
function setStep(name, cls, note) {
  const el = stepEl(name);
  el.classList.remove('active', 'done');
  if (cls) el.classList.add(cls);
  if (note !== undefined) setStepNote(name, note);
}
function setStepNote(name, note) { stepEl(name).querySelector('[data-note]').textContent = note || ''; }
function indeterminate(on) { const bar = $('#batchBar'); bar.classList.toggle('indeterminate', on); if (on) bar.style.width = ''; }
function fmtTime(s) { if (s < 60) return `${Math.ceil(s)}s`; const m = Math.floor(s / 60); return `${m}m ${Math.round(s % 60)}s`; }
function baseName(p) { const b = String(p).split('/').pop(); return b.length > 42 ? b.slice(0, 39) + '…' : b; }

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderPending(name) {
  const card = document.createElement('article');
  card.className = 'card pending';
  card.innerHTML = `<div class="pending-row"><span class="spinner"></span><span><span class="pending-name">${escapeHtml(name)}</span> · finding the smallest file…</span></div>`;
  results.prepend(card);
  return card;
}

function renderError(card, name, message) {
  card.className = 'card error';
  card.innerHTML = `<div class="pending-row"><span style="color:var(--danger);font-weight:700">✕</span><span><span class="pending-name">${escapeHtml(name)}</span> · ${escapeHtml(message)}</span></div>`;
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
  if (best.grewLargerThanSource) warns.push('This is larger than your original. The source is already well-optimised, so keep the original.');
  if (best.targetMet === false) {
    warns.push(state.mode === 'size'
      ? "Couldn't reach that size even after downscaling. This is the smallest it goes."
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
