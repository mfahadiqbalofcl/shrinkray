/**
 * Batch orchestration: many images (or a whole ZIP) through the worker pool,
 * results reassembled in an organized way.
 *
 * compressMany() — an array of {path, data} in, per-item results out, parallel.
 * compressZip()  — a ZIP buffer in, a ZIP buffer out with the SAME folder tree,
 *                  every image compressed, plus a manifest.json + REPORT.txt.
 */

import { getPool } from './pool.js';
import { readZip, writeZip, rewriteExtension, uniqueName } from './zip.js';

/**
 * Compress a list of in-memory images in parallel across the worker pool.
 * @param {{path:string,data:Buffer}[]} items
 * @param {import('./pipeline.js').CompressOptions} options
 * @param {(ev)=>void} [onProgress]  { done, total, path, result?/error? }
 */
export async function compressMany(items, options, onProgress) {
  const pool = getPool();
  const jobs = items.map((it) => ({ input: it.data, options, meta: { path: it.path } }));

  const results = await pool.map(jobs, (ev) => {
    onProgress?.({
      done: ev.done,
      total: ev.total,
      path: ev.meta.path,
      ok: !ev.error,
      error: ev.error,
      best: ev.result?.best,
    });
  });

  return results.map((r, i) => ({
    path: items[i].path,
    originalSize: items[i].data.length,
    ...r,
  }));
}

/**
 * Compress every image inside a ZIP and return a new ZIP with identical folder
 * structure. Failed or skipped entries are reported, not silently dropped.
 *
 * @param {Buffer} zipBuffer
 * @param {import('./pipeline.js').CompressOptions} options
 * @param {(ev)=>void} [onProgress]
 * @returns {Promise<{buffer:Buffer, manifest:object, stats:object}>}
 */
export async function compressZip(zipBuffer, options, onProgress) {
  const { images, skipped } = await readZip(zipBuffer);
  if (!images.length) {
    throw new Error('No images found in the ZIP (looked for JPEG, PNG, WebP, AVIF, GIF, TIFF).');
  }

  const results = await compressMany(images, options, onProgress);

  // Reassemble: compressed bytes at the same folder path, new extension.
  const taken = new Set();
  const outEntries = [];
  const manifestFiles = [];
  let totalIn = 0;
  let totalOut = 0;
  let ok = 0;
  let failed = 0;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    totalIn += r.originalSize;
    if (!r.ok || !r.best) {
      failed++;
      manifestFiles.push({ path: r.path, ok: false, error: r.error || 'failed', originalSize: r.originalSize });
      continue;
    }
    ok++;

    // Never ship a file bigger than it came in. If the best encode grew (an
    // already-optimised source), keep the ORIGINAL bytes at their original path.
    if (r.best.grewLargerThanSource) {
      // Reserve the name so a kept original can't collide with another kept
      // original or a recompressed file that maps to the same path.
      const outPath = uniqueName(r.path, taken);
      outEntries.push({ path: outPath, data: images[i].data });
      totalOut += r.originalSize;
      manifestFiles.push({
        path: r.path,
        outPath,
        ok: true,
        keptOriginal: true,
        format: 'original',
        originalSize: r.originalSize,
        size: r.originalSize,
        percentSaved: 0,
        note: `kept original — ${r.best.label} was larger`,
      });
      continue;
    }

    const outPath = rewriteExtension(r.path, r.best.ext, taken);
    outEntries.push({ path: outPath, data: r.best.bytes });
    totalOut += r.best.size;
    manifestFiles.push({
      path: r.path,
      outPath,
      ok: true,
      format: r.best.format,
      originalSize: r.originalSize,
      size: r.best.size,
      percentSaved: Math.round((1 - r.best.ratio) * 100),
      width: r.best.width,
      height: r.best.height,
      score: r.best.score,
      targetMet: r.best.targetMet !== false,
      note: r.best.note,
    });
  }

  const stats = {
    images: images.length,
    compressed: ok,
    failed,
    skipped: skipped.length,
    skippedFiles: skipped,
    totalIn,
    totalOut,
    percentSaved: totalIn > 0 ? Math.round((1 - totalOut / totalIn) * 100) : 0,
  };

  const manifest = {
    tool: 'ShrinkRay',
    createdAt: options._timestamp || null, // stamped by the caller (scripts can't call Date)
    settings: {
      mode: options.mode,
      target: options.mode === 'quality' ? options.target : undefined,
      targetKB: options.mode === 'size' ? options.targetKB : undefined,
      format: options.format || 'auto',
      effort: options.effort,
      maxEdge: options.maxEdge,
    },
    stats,
    files: manifestFiles,
  };

  const buffer = await writeZip(outEntries, {
    'manifest.json': JSON.stringify(manifest, null, 2),
    'REPORT.txt': renderReport(manifest),
  });

  return { buffer, manifest, stats };
}

function renderReport(manifest) {
  const kb = (n) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`);
  const s = manifest.stats;
  const lines = [];
  lines.push('ShrinkRay — compression report');
  lines.push('='.repeat(48));
  const set = manifest.settings;
  const goal = set.mode === 'size' ? `fit ${set.targetKB}KB` : `${set.target} fidelity`;
  lines.push(`Goal:      ${goal}   ·   format: ${set.format}`);
  lines.push(`Images:    ${s.compressed} compressed` + (s.failed ? `, ${s.failed} failed` : '') + (s.skipped ? `, ${s.skipped} skipped` : ''));
  lines.push(`Total:     ${kb(s.totalIn)} -> ${kb(s.totalOut)}   (${s.percentSaved}% smaller)`);
  lines.push('');
  lines.push('Per file:');
  for (const f of manifest.files) {
    if (!f.ok) { lines.push(`  ✗ ${f.path} — ${f.error}`); continue; }
    let line = `  ${f.outPath}  ${kb(f.originalSize)} -> ${kb(f.size)}  (${f.percentSaved}% smaller, ${f.format}, score ${f.score})`;
    if (f.grewLargerThanSource) line += '  [larger than source — original kept better]';
    if (!f.targetMet) line += '  [target not reached]';
    lines.push(line);
  }
  if (s.skippedFiles?.length) {
    lines.push('');
    lines.push('Skipped (not images):');
    for (const p of s.skippedFiles) lines.push(`  - ${p}`);
  }
  return lines.join('\n') + '\n';
}
