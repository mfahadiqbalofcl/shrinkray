/**
 * The compression engine, browser edition. Same idea as the Node tool: don't
 * guess a quality number, binary-search it against the perceptual metric to find
 * the smallest file that stays under a visible-difference ceiling (quality mode)
 * or that fills a KB budget (size mode). Encoding is monotonic in quality, so a
 * seeded search converges in ~3-4 encodes.
 */

import { FORMATS, encode } from './codecs.js';
import { decode, decodeScaled, resizeImageData, flatten, hasAlpha } from './image.js';
import { referenceFromImageData, compareToReference } from './metric.js';
import { QUALITY_TARGETS, visualScore } from '../../../core/dssim.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const SEED = {
  'visually-lossless': { avif: 88, webp: 92, jpeg: 92 },
  high: { avif: 72, webp: 85, jpeg: 85 },
  balanced: { avif: 55, webp: 78, jpeg: 78 },
  small: { avif: 40, webp: 62, jpeg: 62 },
  tiny: { avif: 28, webp: 45, jpeg: 45 },
};

async function bisect(probe, satisfies, prefer, [lo, hi], seed, { maxIters = 5, goodEnough, climbCapAt } = {}) {
  let best = null;
  const seen = new Map();
  const at = async (q) => {
    q = clamp(Math.round(q), lo, hi);
    if (seen.has(q)) return seen.get(q);
    const c = await probe(q);
    seen.set(q, c);
    return c;
  };
  let next = clamp(seed, lo, hi);
  for (let i = 0; i < maxIters && lo <= hi; i++) {
    const c = await at(next);
    const ok = satisfies(c);
    if (ok && (!best || prefer(c, best))) best = c;
    if (ok && goodEnough?.(c)) break;
    if (!ok && c.dir === 'down' && climbCapAt && c.quality >= climbCapAt) break;
    if (c.dir === 'down' ? ok : !ok) hi = c.quality - 1;
    else lo = c.quality + 1;
    next = Math.floor((lo + hi) / 2);
  }
  return { best, evaluated: [...seen.values()] };
}

/**
 * Compress one already-decoded source.
 * @param {ImageData} source  the working pixels (already resized/flattened as needed)
 * @param {object} opts { format, mode, target, targetKB, effort }
 * @param {object} ctx  { originalSize, width, height, note }
 */
// AVIF is the one slow WASM codec, so search it FAST and re-encode the winner
// at a better setting once. Other formats encode quickly, so search == final.
const FINAL_EFFORT = { avif: 4, webp: 4, jpeg: 1, png: 0 };
const SEARCH_EFFORT = { avif: 1, webp: 4, jpeg: 1, png: 0 };

async function run(source, fmt, opts, ctx) {
  const reference = await referenceFromImageData(source);
  const finalEffort = opts.effort ?? FINAL_EFFORT[fmt.id] ?? 4;
  const searchEffort = opts.effort != null ? opts.effort : (SEARCH_EFFORT[fmt.id] ?? finalEffort);
  const mime = fmt.mime;

  const finalize = (buffer, d, note, targetMet = true) => {
    const size = buffer.byteLength;
    return {
      bytes: buffer, format: fmt.id, label: fmt.label, ext: fmt.ext, mime,
      size, dssim: d, score: visualScore(d),
      width: source.width, height: source.height,
      originalSize: ctx.originalSize, ratio: size / ctx.originalSize,
      savedBytes: ctx.originalSize - size,
      grewLargerThanSource: size >= ctx.originalSize,
      targetMet, note,
    };
  };

  // PNG is lossless here; just encode once.
  if (!fmt.lossy || opts.target === 'lossless') {
    const buffer = await encode(source, fmt.id, { quality: 100, effort: finalEffort });
    return finalize(buffer, 0, 'lossless');
  }

  if (opts.mode === 'size') {
    // Size mode must measure at the effort we ship, so it fills the budget.
    const targetBytes = Math.round(opts.targetKB * 1024);
    const probe = async (quality) => {
      const buffer = await encode(source, fmt.id, { quality, effort: finalEffort });
      return { quality, buffer, size: buffer.byteLength, dir: 'up' };
    };
    const { best, evaluated } = await bisect(
      probe,
      (c) => c.size <= targetBytes,
      (a, b) => a.size > b.size,
      fmt.quality, 55,
      { goodEnough: (c) => c.size >= targetBytes * 0.92 }
    );
    const winner = best ?? evaluated.reduce((a, b) => (a.size <= b.size ? a : b));
    const d = await compareToReference(reference, winner.buffer, mime);
    return finalize(winner.buffer, d, best ? `q${winner.quality}` : `q${winner.quality} (target not reachable)`, !!best);
  }

  // Quality mode: search FAST, then re-encode the winner once at the final effort.
  const ceiling = typeof opts.target === 'number' ? opts.target : QUALITY_TARGETS[opts.target ?? 'high'];
  const seed = SEED[opts.target]?.[fmt.id] ?? 70;
  const probe = async (quality) => {
    const buffer = await encode(source, fmt.id, { quality, effort: searchEffort });
    const d = await compareToReference(reference, buffer, mime);
    return { quality, buffer, size: buffer.byteLength, dssim: d, dir: 'down' };
  };
  const { best, evaluated } = await bisect(
    probe,
    (c) => c.dssim <= ceiling,
    (a, b) => a.size < b.size,
    fmt.quality, seed,
    { goodEnough: (c) => c.dssim >= ceiling * 0.75, climbCapAt: 93 }
  );
  const chosen = best ?? evaluated.reduce((a, b) => (a.dssim <= b.dssim ? a : b));

  // Re-encode the winner once at the final effort (smaller file, same quality).
  // Higher effort only shrinks the file and never raises DSSIM, so the guarantee
  // holds; we re-measure to report the honest number.
  if (finalEffort !== searchEffort) {
    const buffer = await encode(source, fmt.id, { quality: chosen.quality, effort: finalEffort });
    const d = await compareToReference(reference, buffer, mime);
    return finalize(buffer, d, `q${chosen.quality}`, d <= ceiling);
  }
  return finalize(chosen.buffer, chosen.dssim, `q${chosen.quality}`, chosen.dssim <= ceiling);
}

/**
 * Public: compress raw file bytes with one format.
 * @param {ArrayBuffer|Uint8Array} input
 * @param {string} inputType  MIME of the input (for decode)
 * @param {object} opts { format, mode, target, targetKB, effort, maxEdge, background }
 */
export async function compress(input, inputType, opts) {
  const fmt = FORMATS[opts.format];
  if (!fmt) throw new Error(`Unknown format: ${opts.format}`);
  const originalSize = input.byteLength ?? input.length;

  // Decode (optionally downscale), then flatten alpha for opaque-only formats.
  let source = opts.maxEdge
    ? await decodeScaled(input, inputType, opts.maxEdge)
    : await decode(input, inputType);
  if (!fmt.alpha && hasAlpha(source)) source = await flatten(source, opts.background);

  return run(source, fmt, opts, { originalSize });
}

/**
 * Encode ONCE at an explicit quality (no search). Powers the live precision
 * panel, where the user drags a quality slider and sees the result update.
 */
export async function probeOnce(input, inputType, opts) {
  const fmt = FORMATS[opts.format];
  if (!fmt) throw new Error(`Unknown format: ${opts.format}`);
  const originalSize = input.byteLength ?? input.length;
  let source = opts.maxEdge ? await decodeScaled(input, inputType, opts.maxEdge) : await decode(input, inputType);
  if (!fmt.alpha && hasAlpha(source)) source = await flatten(source, opts.background);
  const reference = await referenceFromImageData(source);
  const quality = fmt.lossy ? clamp(Math.round(opts.quality ?? 75), 1, 100) : 100;
  const effort = opts.effort ?? FINAL_EFFORT[fmt.id] ?? 4;
  const buffer = await encode(source, fmt.id, { quality, effort });
  const d = fmt.lossy ? await compareToReference(reference, buffer, fmt.mime) : 0;
  const size = buffer.byteLength;
  return {
    bytes: buffer, format: fmt.id, label: fmt.label, ext: fmt.ext, mime: fmt.mime,
    size, dssim: d, score: visualScore(d), quality,
    width: source.width, height: source.height, originalSize,
    ratio: size / originalSize, savedBytes: originalSize - size,
    grewLargerThanSource: size >= originalSize, note: `q${quality}`, targetMet: true,
  };
}

/** Try several formats, return the smallest that met the goal + all candidates. */
export async function compressAuto(input, inputType, opts) {
  const wanted = opts.formats?.length ? opts.formats : ['avif', 'webp', 'jpeg'];
  const originalSize = input.byteLength ?? input.length;

  // Decode once; reuse the pixels across formats.
  let base = opts.maxEdge ? await decodeScaled(input, inputType, opts.maxEdge) : await decode(input, inputType);
  const alpha = hasAlpha(base);

  const candidates = [];
  for (const id of wanted) {
    const fmt = FORMATS[id];
    if (!fmt) continue;
    const source = !fmt.alpha && alpha ? await flatten(base, opts.background) : base;
    try {
      candidates.push(await run(source, fmt, opts, { originalSize }));
    } catch (err) {
      candidates.push({ format: id, error: err.message });
    }
  }
  const ok = candidates.filter((c) => !c.error);
  const met = ok.filter((c) => c.targetMet !== false);
  const pool = met.length ? met : ok;
  const best = pool.reduce((a, b) => (a.size <= b.size ? a : b));
  return { best, candidates: ok.sort((a, b) => a.size - b.size) };
}
