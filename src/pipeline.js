/**
 * Public API. Everything the server and CLI call goes through here.
 *
 * compress()      — one image, one format, either mode (quality-target or size-target).
 * compressAuto()  — one image, try every requested format, return the winner
 *                   (smallest file that meets the goal) plus the full comparison.
 *
 * The design keeps decisions explicit: the caller says what "done" means
 * (a KB budget or a named visual target), picks formats, and gets back real
 * measured numbers — size, DSSIM, a 0-100 visual score — never a silent guess.
 */

import { getFormat, availableFormats } from './formats.js';
import { searchByQuality, searchBySize, decodeSource } from './search.js';
import { QUALITY_TARGETS } from './metric.js';

export { availableFormats, QUALITY_TARGETS };
export { visualScore } from './metric.js';

/**
 * @typedef {Object} CompressOptions
 * @property {string} format               'avif' | 'webp' | 'jpeg' | 'png' | 'jxl'
 * @property {'quality'|'size'} mode
 * @property {string|number} [target]      quality mode: named target or raw DSSIM
 * @property {number} [targetKB]           size mode: kilobyte budget
 * @property {number} [effort]
 * @property {number} [maxEdge]            hard cap on the longest edge (px)
 * @property {string} [background]         flatten colour for opaque formats
 */

/**
 * Compress one image with one format.
 * @param {Buffer} input
 * @param {CompressOptions} options
 */
export async function compress(input, options) {
  if (!Buffer.isBuffer(input) || input.length === 0) {
    throw new Error('compress() needs a non-empty image Buffer');
  }
  const format = getFormat(options.format);
  if (!(await format.available())) {
    throw new Error(`${format.label} is not available on this machine`);
  }

  const shared = {
    effort: options.effort,
    maxEdge: options.maxEdge,
    background: options.background,
    source: options.source, // shared pre-decoded pixels (compressAuto passes this)
    beatSize: options.beatSize, // auto-mode pruning: stop if we can't beat this
    maxIters: options.maxIters,
  };

  let result;
  if (options.mode === 'size') {
    result = await searchBySize(input, format, { ...shared, targetBytes: Math.round(options.targetKB * 1024) });
  } else if (options.mode === 'quality') {
    result = await searchByQuality(input, format, { ...shared, target: options.target ?? 'high' });
  } else {
    throw new Error(`Unknown mode: ${options.mode} (use 'quality' or 'size')`);
  }

  return { format: format.id, label: format.label, ext: format.ext, mime: format.mime, ...result };
}

/**
 * Try several formats and return the best result plus every candidate.
 *
 * "Best" = meets the goal with the smallest file. In size mode every format is
 * bounded by the same byte budget, so best = smallest that still met it (or, if
 * none met it, the smallest overall). In quality mode every format is held to
 * the same perceptual ceiling, so best = smallest file at that fidelity — which
 * is the honest way to answer "which format should I actually use here?"
 *
 * @param {Buffer} input
 * @param {Omit<CompressOptions,'format'> & {formats?: string[]}} options
 * @param {(ev:{format:string,phase:string})=>void} [onProgress]
 */
export async function compressAuto(input, options, onProgress) {
  // Best-compressing formats first. In quality mode the winner is almost always
  // AVIF/JXL, so trying them first sets a tight size to beat — later formats
  // then bail the moment they exceed it instead of running a full search.
  const PREFERENCE = ['avif', 'jxl', 'webp', 'jpeg'];
  const requested = options.formats?.length
    ? options.formats
    : (await availableFormats()).map((f) => f.id).filter((id) => id !== 'png');
  const wanted = PREFERENCE.filter((id) => requested.includes(id)).concat(requested.filter((id) => !PREFERENCE.includes(id)));

  // Decode the original ONCE and share the raw pixels with every format, so a
  // 3-5 way comparison doesn't re-decode (and re-orient) the source each time.
  const source = await decodeSource(input, { maxEdge: options.maxEdge });

  const candidates = [];
  let bestSize = Infinity; // running smallest, used to prune losing formats
  for (const id of wanted) {
    const fmt = getFormat(id);
    if (!(await fmt.available())) continue;
    onProgress?.({ format: id, phase: 'start' });
    try {
      // In quality mode, tell each format the size it must beat to matter.
      const beatSize = options.mode !== 'size' && Number.isFinite(bestSize) ? bestSize : undefined;
      const r = await compress(input, { ...options, format: id, source, beatSize });
      candidates.push(r);
      if (r.targetMet !== false && r.size < bestSize) bestSize = r.size;
      onProgress?.({ format: id, phase: 'done' });
    } catch (err) {
      onProgress?.({ format: id, phase: 'error', message: err.message });
    }
  }

  if (!candidates.length) throw new Error('No format could encode this image');

  // Prefer candidates that actually met the target; among those, smallest file.
  const met = candidates.filter((c) => c.targetMet !== false);
  const pool = met.length ? met : candidates;
  const best = pool.reduce((a, b) => (a.size <= b.size ? a : b));

  return { best, candidates: candidates.sort((a, b) => a.size - b.size) };
}

/** Human-friendly one-liner for a result, used by the CLI and logs. */
export function summarize(r) {
  const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
  const pct = Math.round((1 - r.ratio) * 100);
  return `${r.label} ${kb(r.size)} (${pct}% smaller, ${r.width}×${r.height}, score ${r.score}/100, ${r.note})`;
}
