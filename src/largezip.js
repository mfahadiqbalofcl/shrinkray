/**
 * Streaming, disk-backed ZIP processing for large archives (hundreds of MB to
 * multiple GB). The whole point is that the archive is NEVER fully in memory:
 *
 *   yauzl reads the central directory up front (so we know the image count for
 *   an accurate progress bar), then hands out one entry stream at a time. Each
 *   image is read into a small buffer, compressed on the worker pool, and its
 *   result streamed straight into a yazl output ZIP that writes to disk. At any
 *   moment only ~poolSize images are in RAM, regardless of archive size.
 *
 * Stages reported via onProgress: 'reading' -> 'compressing' (done/total) ->
 * 'packaging' -> returns stats. The caller layers 'uploading' before this.
 */

import yauzl from 'yauzl';
import yazl from 'yazl';
import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { getPool } from './pool.js';
import { isCompressibleImage, rewriteExtension } from './zip.js';

function openZip(path) {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (err, zip) => (err ? reject(err) : resolve(zip)));
  });
}

/** Sweep the central directory for entry metadata only (no decompression). */
function collectEntries(zipfile) {
  return new Promise((resolve, reject) => {
    const entries = [];
    zipfile.on('entry', (e) => { entries.push(e); zipfile.readEntry(); });
    zipfile.on('end', () => resolve(entries));
    zipfile.on('error', reject);
    zipfile.readEntry();
  });
}

/** Read one entry's bytes into a Buffer (one image at a time — small). */
function readEntryBuffer(zipfile, entry) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err) return reject(err);
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  });
}

/**
 * Run `work(entry, data, index)` over entries with bounded concurrency, while
 * serializing the actual reads (a single file descriptor, so reads take turns;
 * compression then overlaps across the pool).
 */
async function processEntries(zipfile, entries, concurrency, work) {
  let cursor = 0;
  let readChain = Promise.resolve();
  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= entries.length) return;
      const entry = entries[index];
      // Serialize the openReadStream calls through a chained promise.
      let release;
      const prev = readChain;
      readChain = new Promise((r) => (release = r));
      await prev;
      let data;
      try {
        data = await readEntryBuffer(zipfile, entry);
      } finally {
        release();
      }
      await work(entry, data, index);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

const isDir = (name) => name.endsWith('/');

/**
 * Compress every image in the ZIP at `inPath`, writing a new ZIP to `outPath`
 * with the folder tree preserved. Returns { stats, manifest }.
 *
 * @param {string} inPath
 * @param {string} outPath
 * @param {import('./pipeline.js').CompressOptions} options
 * @param {(ev)=>void} [onProgress]
 */
export async function processZipFile(inPath, outPath, options, onProgress) {
  const pool = getPool();
  const zipfile = await openZip(inPath);

  try {
    onProgress?.({ stage: 'reading' });
    const entries = await collectEntries(zipfile);
    const imageEntries = entries.filter((e) => !isDir(e.fileName) && isCompressibleImage(e.fileName));
    const skipped = entries
      .filter((e) => !isDir(e.fileName) && !isCompressibleImage(e.fileName) && !e.fileName.startsWith('__MACOSX/'))
      .map((e) => e.fileName);

    const total = imageEntries.length;
    if (total === 0) throw new Error('No images found in the ZIP (JPEG, PNG, WebP, AVIF, GIF, TIFF).');
    onProgress?.({ stage: 'start', total, skipped: skipped.length });

    // Output ZIP streams straight to disk as entries are added.
    const outZip = new yazl.ZipFile();
    const outStream = createWriteStream(outPath);
    const written = new Promise((resolve, reject) => {
      outZip.outputStream.pipe(outStream).on('close', resolve).on('error', reject);
    });

    const taken = new Set();
    const manifestFiles = [];
    let totalIn = 0, totalOut = 0, done = 0, ok = 0, failed = 0;

    await processEntries(zipfile, imageEntries, pool.size, async (entry, data) => {
      totalIn += data.length;
      try {
        const { best } = await pool.run(data, options);
        if (best.grewLargerThanSource) {
          // Never ship a file bigger than it came in — keep the original.
          outZip.addBuffer(data, entry.fileName, { compress: false });
          totalOut += data.length;
          manifestFiles.push({ path: entry.fileName, outPath: entry.fileName, ok: true, keptOriginal: true, format: 'original', originalSize: data.length, size: data.length, percentSaved: 0 });
        } else {
          const outName = rewriteExtension(entry.fileName, best.ext, taken);
          // Images are already entropy-coded; store (no deflate) so packaging is fast.
          outZip.addBuffer(Buffer.from(best.bytes), outName, { compress: false });
          totalOut += best.size;
          manifestFiles.push({ path: entry.fileName, outPath: outName, ok: true, format: best.format, originalSize: data.length, size: best.size, percentSaved: Math.round((1 - best.ratio) * 100), score: best.score, targetMet: best.targetMet !== false, note: best.note });
        }
        ok++;
      } catch (err) {
        failed++;
        manifestFiles.push({ path: entry.fileName, ok: false, error: err.message, originalSize: data.length });
      }
      done++;
      onProgress?.({ stage: 'compressing', done, total, totalIn, totalOut, name: entry.fileName });
    });

    onProgress?.({ stage: 'packaging' });
    const stats = { images: total, compressed: ok, failed, skipped: skipped.length, totalIn, totalOut, percentSaved: totalIn ? Math.round((1 - totalOut / totalIn) * 100) : 0 };
    const manifest = { tool: 'ShrinkRay', settings: options, stats, files: manifestFiles };
    outZip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), 'manifest.json');
    outZip.addBuffer(Buffer.from(renderReport(manifest, skipped)), 'REPORT.txt');
    outZip.end();
    await written;

    const outSize = (await stat(outPath)).size;
    onProgress?.({ stage: 'done', stats, outSize });
    return { stats, manifest, outSize };
  } finally {
    zipfile.close();
  }
}

function kb(n) { return n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`; }

function renderReport(manifest, skipped) {
  const s = manifest.stats;
  const lines = [
    'ShrinkRay — compression report',
    '='.repeat(48),
    `Images: ${s.compressed} compressed${s.failed ? `, ${s.failed} failed` : ''}${s.skipped ? `, ${s.skipped} skipped` : ''}`,
    `Total:  ${kb(s.totalIn)} -> ${kb(s.totalOut)} (${s.percentSaved}% smaller)`,
    '',
    'Per file:',
  ];
  for (const f of manifest.files) {
    if (!f.ok) { lines.push(`  ✗ ${f.path} — ${f.error}`); continue; }
    lines.push(`  ${f.outPath}  ${kb(f.originalSize)} -> ${kb(f.size)}  (${f.percentSaved}% smaller, ${f.format})` + (f.keptOriginal ? '  [kept original]' : ''));
  }
  if (skipped.length) { lines.push('', 'Skipped (not images):'); for (const p of skipped) lines.push(`  - ${p}`); }
  return lines.join('\n') + '\n';
}
