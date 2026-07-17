/**
 * Local HTTP server. Node's built-in http + the sharp/pool core. Everything
 * runs on 127.0.0.1; images live in memory, are compressed by a worker pool,
 * and streamed back. Nothing is written to disk and nothing leaves the machine.
 *
 * Compression progress is streamed as NDJSON so a 200-image ZIP shows a live
 * bar instead of a spinner that hangs for a minute. The packaged result (a ZIP,
 * or a ZIP of loose images) is held briefly in memory and fetched by id.
 *
 * Routes:
 *   GET  /                    the UI
 *   GET  /api/formats         which codecs are available here
 *   POST /api/compress        multipart images OR a .zip -> NDJSON progress stream
 *   GET  /api/download/:id    stream a packaged ZIP result
 */

import http from 'node:http';
import { readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { availableFormats, QUALITY_TARGETS } from './pipeline.js';
import { parseMultipart } from './multipart.js';
import { compressMany } from './batch.js';
import { readZip, writeZip, rewriteExtension } from './zip.js';
import { processZipFile } from './largezip.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

// Loose-image (multipart) uploads are held in memory, so keep a sane cap. Large
// archives go through the raw-body ZIP endpoint, which streams to disk and has
// no practical size limit.
const MAX_MULTIPART = 512 * 1024 * 1024;
const DOWNLOAD_TTL_MS = 30 * 60 * 1000;

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Packaged results, keyed by id, briefly held for download. A result is either
// an in-memory buffer (loose "download all") or a path to a ZIP on disk (large
// archive output, never loaded into memory).
const downloads = new Map();
function stashDownload(item) {
  const id = randomUUID();
  const timer = setTimeout(() => discardDownload(id), DOWNLOAD_TTL_MS);
  timer.unref?.();
  downloads.set(id, item); // { buffer, filename } | { path, dir, filename }
  return id;
}
async function discardDownload(id) {
  const item = downloads.get(id);
  if (!item) return;
  downloads.delete(id);
  if (item.dir) await rm(item.dir, { recursive: true, force: true }).catch(() => {});
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req, limit = MAX_MULTIPART) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Upload too large for in-memory handling — send it as a .zip instead'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Options from URL query params (raw-body ZIP endpoint). */
function optionsFromQuery(params) {
  const mode = params.get('mode') === 'size' ? 'size' : 'quality';
  return {
    mode,
    format: params.get('format') || 'auto',
    target: params.get('target') || 'high',
    targetKB: params.get('targetKB') ? Number(params.get('targetKB')) : undefined,
    effort: params.get('effort') ? Number(params.get('effort')) : undefined,
    maxEdge: params.get('maxEdge') ? Number(params.get('maxEdge')) : undefined,
  };
}

function optionsFromFields(fields) {
  const mode = fields.mode === 'size' ? 'size' : 'quality';
  return {
    mode,
    format: fields.format || 'auto',
    target: fields.target || 'high',
    targetKB: fields.targetKB ? Number(fields.targetKB) : undefined,
    effort: fields.effort ? Number(fields.effort) : undefined,
    maxEdge: fields.maxEdge ? Number(fields.maxEdge) : undefined,
    background: fields.background || undefined,
  };
}

/** Worker results carry `bytes` (Uint8Array); shape them for the client. */
function bestToJson(best, includeData) {
  const out = {
    format: best.format,
    label: best.label,
    ext: best.ext,
    mime: best.mime,
    size: best.size,
    originalSize: best.originalSize,
    ratio: best.ratio,
    percentSaved: Math.round((1 - best.ratio) * 100),
    width: best.width,
    height: best.height,
    dssim: best.dssim,
    score: best.score,
    note: best.note,
    targetMet: best.targetMet !== false,
    grewLargerThanSource: !!best.grewLargerThanSource,
  };
  if (includeData && best.bytes) {
    out.dataUrl = `data:${best.mime};base64,${Buffer.from(best.bytes).toString('base64')}`;
  }
  return out;
}

async function handleCompress(req, res) {
  const raw = await readBody(req);
  const contentType = req.headers['content-type'] || '';
  if (!contentType.startsWith('multipart/form-data')) {
    return sendJson(res, 400, { error: 'Expected multipart/form-data' });
  }
  const { fields, files } = parseMultipart(raw, contentType);
  if (!files.length) return sendJson(res, 400, { error: 'No files uploaded' });

  const opts = optionsFromFields(fields);

  // Stream NDJSON: one JSON object per line.
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache' });
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');

  const looksZip = (f) => /\.zip$/i.test(f.filename || '') || f.contentType === 'application/zip' || f.contentType === 'application/x-zip-compressed';
  const isZip = files.length === 1 && looksZip(files[0]);

  try {
    if (isZip) {
      await runZip(files[0], opts, send);
    } else {
      await runLoose(files, opts, send);
    }
  } catch (err) {
    send({ type: 'error', error: err.message });
  }
  res.end();
}

/** Loose images: compress in parallel, stream each result (with preview bytes). */
async function runLoose(files, opts, send) {
  const items = files
    .filter((f) => !/\.zip$/i.test(f.filename || ''))
    .map((f) => ({ path: f.filename, data: f.data }));
  send({ type: 'start', total: items.length, isZip: false });

  const collected = [];
  const results = await compressMany(items, opts, (ev) => {
    if (ev.ok && ev.best) {
      send({ type: 'result', name: ev.path, ok: true, best: bestToJson(ev.best, true) });
    } else {
      send({ type: 'result', name: ev.path, ok: false, error: ev.error });
    }
  });

  let totalIn = 0, totalOut = 0, ok = 0;
  const taken = new Set();
  const zipEntries = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    totalIn += r.originalSize;
    if (r.ok && r.best) {
      ok++;
      // For "download all", keep the original if compression grew it.
      if (r.best.grewLargerThanSource) {
        zipEntries.push({ path: r.path, data: items[i].data });
        totalOut += r.originalSize;
      } else {
        const outName = rewriteExtension(r.path, r.best.ext, taken);
        zipEntries.push({ path: outName, data: r.best.bytes });
        totalOut += r.best.size;
      }
      collected.push(r);
    }
  }

  let downloadId = null;
  if (zipEntries.length > 1) {
    const buffer = await writeZip(zipEntries, { 'REPORT.txt': looseReport(collected, totalIn, totalOut) });
    downloadId = stashDownload({ buffer, filename: 'shrinkray-images.zip' });
  }
  send({
    type: 'done',
    stats: { images: items.length, compressed: ok, totalIn, totalOut, percentSaved: totalIn ? Math.round((1 - totalOut / totalIn) * 100) : 0 },
    downloadId,
  });
}

/** ZIP in -> ZIP out, folder structure preserved, live progress. */
async function runZip(file, opts, send) {
  const { images, skipped } = await readZip(file.data);
  if (!images.length) throw new Error('No images found in that ZIP (JPEG, PNG, WebP, AVIF, GIF, TIFF).');
  send({ type: 'start', total: images.length, isZip: true, skipped: skipped.length });

  const results = await compressMany(images, opts, (ev) => {
    send({ type: 'progress', done: ev.done, total: ev.total, name: ev.path, ok: ev.ok, error: ev.error });
  });

  // Reassemble preserving folders; keep originals that would have grown.
  const taken = new Set();
  const entries = [];
  const files = [];
  let totalIn = 0, totalOut = 0, ok = 0, failed = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    totalIn += r.originalSize;
    if (!r.ok || !r.best) {
      failed++;
      files.push({ path: r.path, ok: false, error: r.error });
      continue;
    }
    ok++;
    if (r.best.grewLargerThanSource) {
      entries.push({ path: r.path, data: images[i].data });
      totalOut += r.originalSize;
      files.push({ path: r.path, outPath: r.path, ok: true, keptOriginal: true, format: 'original', originalSize: r.originalSize, size: r.originalSize, percentSaved: 0 });
    } else {
      const outPath = rewriteExtension(r.path, r.best.ext, taken);
      entries.push({ path: outPath, data: r.best.bytes });
      totalOut += r.best.size;
      files.push({ path: r.path, outPath, ok: true, format: r.best.format, originalSize: r.originalSize, size: r.best.size, percentSaved: Math.round((1 - r.best.ratio) * 100), score: r.best.score, targetMet: r.best.targetMet !== false, note: r.best.note });
    }
  }

  const stats = { images: images.length, compressed: ok, failed, skipped: skipped.length, totalIn, totalOut, percentSaved: totalIn ? Math.round((1 - totalOut / totalIn) * 100) : 0 };
  const manifest = { tool: 'ShrinkRay', settings: opts, stats, files };
  const buffer = await writeZip(entries, {
    'manifest.json': JSON.stringify(manifest, null, 2),
    'REPORT.txt': zipReport(manifest, skipped),
  });
  const downloadId = stashDownload(buffer, 'shrinkray-compressed.zip');
  send({ type: 'done', stats, downloadId, files });
}

function kb(n) { return n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`; }

function looseReport(results, totalIn, totalOut) {
  const lines = ['ShrinkRay — compression report', '='.repeat(40), `Total: ${kb(totalIn)} -> ${kb(totalOut)} (${Math.round((1 - totalOut / totalIn) * 100)}% smaller)`, ''];
  for (const r of results) lines.push(`  ${r.path}  ${kb(r.originalSize)} -> ${kb(r.best.size)}  (${Math.round((1 - r.best.ratio) * 100)}% smaller, ${r.best.label})`);
  return lines.join('\n') + '\n';
}

function zipReport(manifest, skipped) {
  const s = manifest.stats;
  const lines = ['ShrinkRay — compression report', '='.repeat(48), `Images: ${s.compressed} compressed${s.failed ? `, ${s.failed} failed` : ''}${s.skipped ? `, ${s.skipped} skipped` : ''}`, `Total:  ${kb(s.totalIn)} -> ${kb(s.totalOut)} (${s.percentSaved}% smaller)`, '', 'Per file:'];
  for (const f of manifest.files) {
    if (!f.ok) { lines.push(`  ✗ ${f.path} — ${f.error}`); continue; }
    lines.push(`  ${f.outPath}  ${kb(f.originalSize)} -> ${kb(f.size)}  (${f.percentSaved}% smaller, ${f.format})` + (f.keptOriginal ? '  [kept original]' : ''));
  }
  if (skipped.length) { lines.push('', 'Skipped (not images):'); for (const p of skipped) lines.push(`  - ${p}`); }
  return lines.join('\n') + '\n';
}

async function handleDownload(req, res, id) {
  const item = downloads.get(id);
  if (!item) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Download expired or not found'); }
  const headers = {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="${item.filename}"`,
  };
  if (item.buffer) {
    headers['content-length'] = item.buffer.length;
    res.writeHead(200, headers);
    return res.end(item.buffer);
  }
  // Disk-backed result (large ZIP): stream it, never load it into memory.
  const st = await stat(item.path).catch(() => null);
  if (!st) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Download no longer available'); }
  headers['content-length'] = st.size;
  res.writeHead(200, headers);
  createReadStream(item.path).pipe(res);
}

/**
 * Large ZIP upload: the raw request body is a .zip, streamed straight to a temp
 * file (never buffered in memory), then processed entry-by-entry to a result
 * ZIP on disk. Progress is streamed back as NDJSON with named stages. This is
 * the path that handles 431 MB / 1 GB+ archives.
 */
async function handleCompressZip(req, res, opts) {
  const dir = await mkdtemp(join(tmpdir(), 'shrinkray-'));
  const inPath = join(dir, 'in.zip');
  const outPath = join(dir, 'out.zip');

  // Phase 1: receive the upload, streaming to disk. (The browser shows upload
  // progress from its own XHR.upload events during this.)
  try {
    await pipeline(req, createWriteStream(inPath));
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    if (!res.headersSent) sendJson(res, 400, { error: `Upload failed: ${err.message}` });
    return;
  }

  // Phase 2: process, streaming staged progress.
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache' });
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');
  try {
    const uploadedSize = (await stat(inPath)).size;
    send({ type: 'uploaded', size: uploadedSize });
    const { stats } = await processZipFile(inPath, outPath, opts, (ev) => {
      if (ev.stage === 'reading') send({ type: 'stage', stage: 'reading' });
      else if (ev.stage === 'start') send({ type: 'start', total: ev.total, skipped: ev.skipped, isZip: true });
      else if (ev.stage === 'compressing') send({ type: 'progress', done: ev.done, total: ev.total, totalIn: ev.totalIn, totalOut: ev.totalOut, name: ev.name });
      else if (ev.stage === 'packaging') send({ type: 'stage', stage: 'packaging' });
    });
    await rm(inPath, { force: true }).catch(() => {}); // input no longer needed
    const downloadId = stashDownload({ path: outPath, dir, filename: 'shrinkray-compressed.zip' });
    send({ type: 'done', stats, downloadId });
  } catch (err) {
    send({ type: 'error', error: err.message });
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  res.end();
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': STATIC_TYPES[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/api/formats') {
      return sendJson(res, 200, { formats: await availableFormats(), targets: Object.keys(QUALITY_TARGETS) });
    }
    if (req.method === 'POST' && url.pathname === '/api/compress-zip') {
      return await handleCompressZip(req, res, optionsFromQuery(url.searchParams));
    }
    if (req.method === 'POST' && url.pathname === '/api/compress') {
      return await handleCompress(req, res);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/download/')) {
      return await handleDownload(req, res, decodeURIComponent(url.pathname.slice('/api/download/'.length)));
    }
    if (req.method === 'GET') return await serveStatic(req, res, url.pathname);
    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message || 'Internal error' });
    else res.end();
  }
});

const PORT = Number(process.env.PORT) || 4747;
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log(`\n  ShrinkRay running at  http://${HOST}:${PORT}`);
  console.log(`  Local-first · parallel · ZIP in/out · Ctrl+C to stop\n`);
});
