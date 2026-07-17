/**
 * Zero-dependency HTTP server. Node's built-in http + the sharp core, nothing
 * else — so `npx shrinkray` or `npm start` boots instantly with no framework to
 * audit and nothing that phones home. Everything runs on localhost; images are
 * read into memory, compressed, and streamed back. No file is ever written to
 * disk and no byte leaves the machine.
 *
 * Routes:
 *   GET  /                    the UI
 *   GET  /api/formats         which codecs are available here
 *   POST /api/compress        multipart image(s) -> compressed result(s) as JSON
 *   POST /api/download        re-run one settled result and stream the bytes
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { compress, compressAuto, availableFormats, QUALITY_TARGETS } from './pipeline.js';
import { parseMultipart } from './multipart.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

const MAX_UPLOAD = 60 * 1024 * 1024; // 60MB/request — generous for local use

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

/** Collect a request body up to a hard cap, rejecting oversized uploads early. */
function readBody(req, limit = MAX_UPLOAD) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Upload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Map a settled result to the JSON the UI consumes (buffer -> data URL). */
function resultToJson(r, includeData = true) {
  const out = {
    format: r.format,
    label: r.label,
    ext: r.ext,
    mime: r.mime,
    size: r.size,
    originalSize: r.originalSize,
    ratio: r.ratio,
    savedBytes: r.savedBytes,
    percentSaved: Math.round((1 - r.ratio) * 100),
    width: r.width,
    height: r.height,
    dssim: r.dssim,
    score: r.score,
    note: r.note,
    targetMet: r.targetMet !== false,
    grewLargerThanSource: !!r.grewLargerThanSource,
  };
  if (includeData) out.dataUrl = `data:${r.mime};base64,${r.buffer.toString('base64')}`;
  return out;
}

async function handleCompress(req, res) {
  const raw = await readBody(req);
  const contentType = req.headers['content-type'] || '';
  if (!contentType.startsWith('multipart/form-data')) {
    return sendJson(res, 400, { error: 'Expected multipart/form-data' });
  }

  const { fields, files } = parseMultipart(raw, contentType);
  if (!files.length) return sendJson(res, 400, { error: 'No image uploaded' });

  // Build compression options from the form, with safe defaults.
  const mode = fields.mode === 'size' ? 'size' : 'quality';
  const opts = {
    mode,
    target: fields.target || 'high',
    targetKB: fields.targetKB ? Number(fields.targetKB) : undefined,
    effort: fields.effort ? Number(fields.effort) : undefined,
    maxEdge: fields.maxEdge ? Number(fields.maxEdge) : undefined,
    background: fields.background || undefined,
  };

  const auto = fields.format === 'auto' || !fields.format;
  const formats = auto ? undefined : [fields.format];

  const results = [];
  for (const file of files) {
    try {
      if (auto) {
        const { best, candidates } = await compressAuto(file.data, { ...opts, formats });
        results.push({
          name: file.filename,
          ok: true,
          best: resultToJson(best),
          candidates: candidates.map((c) => resultToJson(c, false)),
        });
      } else {
        const r = await compress(file.data, { ...opts, format: fields.format });
        results.push({ name: file.filename, ok: true, best: resultToJson(r), candidates: [resultToJson(r, false)] });
      }
    } catch (err) {
      results.push({ name: file.filename, ok: false, error: err.message });
    }
  }

  sendJson(res, 200, { results });
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  // Contain within PUBLIC_DIR — reject any traversal attempt.
  const filePath = join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const data = await readFile(filePath);
    const type = STATIC_TYPES[extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
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
      return sendJson(res, 200, {
        formats: await availableFormats(),
        targets: Object.keys(QUALITY_TARGETS),
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/compress') {
      return await handleCompress(req, res);
    }
    if (req.method === 'GET') {
      return await serveStatic(req, res, url.pathname);
    }
    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    const status = err.status || 500;
    sendJson(res, status, { error: err.message || 'Internal error' });
  }
});

const PORT = Number(process.env.PORT) || 4747;
const HOST = process.env.HOST || '127.0.0.1'; // localhost only by default

server.listen(PORT, HOST, () => {
  const jxl = '';
  console.log(`\n  ShrinkRay running at  http://${HOST}:${PORT}${jxl}`);
  console.log(`  Local-first · nothing uploaded · Ctrl+C to stop\n`);
});
