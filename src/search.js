/**
 * The two searches that make this tool more than a format converter.
 *
 *   searchByQuality  — "make it as small as possible without visible loss"
 *                      Binary-search the quality knob for the SMALLEST file
 *                      whose DSSIM stays under a perceptual ceiling.
 *
 *   searchBySize     — "make it fit in N kilobytes"
 *                      Binary-search quality for the LARGEST file that still
 *                      fits the byte budget; if even minimum quality overshoots,
 *                      progressively downscale and try again.
 *
 * Speed notes (why this is fast):
 *  - The source is decoded to raw pixels ONCE. Every encode reads those raw
 *    pixels directly — no PNG re-encode/re-decode per iteration.
 *  - The metric reference is built ONCE from those same raw pixels.
 *  - Callers (compressAuto) can pass a shared decoded source so N formats don't
 *    each re-decode the original.
 *  - The search is SEEDED near the likely answer and capped, so it converges in
 *    ~4 encodes instead of ~8. Encoding is monotonic in quality (higher quality
 *    => bigger file and lower DSSIM), which is what makes the search valid.
 */

import sharp from 'sharp';
import { prepareReference, compareToReference, QUALITY_TARGETS, visualScore } from './metric.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Seeds: where to start the quality search per format, so the first probe lands
 * close and the bisect converges in a few steps. These are the equal-quality
 * mappings from the codec literature (industrialempathy), turned into a
 * starting guess per named fidelity target.
 */
const QUALITY_SEED = {
  'visually-lossless': { avif: 88, webp: 92, jpeg: 92, png: 100, jxl: 90 },
  high: { avif: 72, webp: 85, jpeg: 85, png: 90, jxl: 80 },
  balanced: { avif: 55, webp: 78, jpeg: 78, png: 80, jxl: 72 },
  small: { avif: 40, webp: 62, jpeg: 62, png: 60, jxl: 55 },
  tiny: { avif: 28, webp: 45, jpeg: 45, png: 40, jxl: 40 },
};

/**
 * Binary search over an integer quality range, seeded at `seed`.
 *
 * @param {(q:number)=>Promise<{buffer:Buffer,size:number,dssim?:number,dir:string}>} probe
 * @param {(cand)=>boolean} satisfies  true if a candidate meets the constraint
 * @param {(a,b)=>boolean} prefer  is candidate a "better" than best-so-far b
 * @param {[number,number]} range  inclusive quality bounds
 * @param {number} seed  first quality to probe
 * @param {number} maxIters
 */
async function bisect(probe, satisfies, prefer, range, seed, opts = {}) {
  const { maxIters = 5, goodEnough, beatSize } = opts;
  let [lo, hi] = range;
  let best = null;
  const seen = new Map();

  const at = async (q) => {
    q = clamp(Math.round(q), range[0], range[1]);
    if (seen.has(q)) return seen.get(q);
    const cand = await probe(q);
    seen.set(q, cand);
    return cand;
  };

  // First probe at the seed (not the midpoint) so a good guess pays off.
  let next = clamp(seed ?? Math.floor((lo + hi) / 2), lo, hi);
  let iters = 0;
  while (lo <= hi && iters < maxIters) {
    iters++;
    const cand = await at(next);
    const ok = satisfies(cand);
    if (ok && (!best || prefer(cand, best))) best = cand;

    // Stop as soon as a satisfying candidate is already near-optimal — one more
    // encode+metric wouldn't buy a meaningfully better result. This is what
    // turns a good seed into a 2-3 probe search instead of a full 5.
    if (ok && goodEnough?.(cand)) break;

    // Auto-mode pruning: this format already meets fidelity but is bigger than
    // the current best across formats, so it can't win — stop searching it.
    if (ok && beatSize && cand.size >= beatSize) break;

    // Unreachable-target guard (quality mode). If a near-max-quality probe still
    // can't meet the ceiling, no format setting will on this image — accept the
    // best effort now instead of grinding q93 -> q100 (which is slow AND
    // balloons the file for a fidelity gain nobody can see). This is the single
    // biggest speed win on already-compressed sources in Auto mode.
    if (!ok && cand.dir === 'down' && cand.quality >= 93) break;

    // 'down': quality up lowers DSSIM (satisfies) — a satisfying probe means we
    // can try LOWER quality (smaller file). 'up': quality up grows the file —
    // a fitting probe means we can try HIGHER quality.
    if (cand.dir === 'down' ? ok : !ok) hi = cand.quality - 1;
    else lo = cand.quality + 1;

    next = Math.floor((lo + hi) / 2);
  }
  return { best, evaluated: [...seen.values()], iterations: iters };
}

// ---------------------------------------------------------------------------
// Quality-target search
// ---------------------------------------------------------------------------

/**
 * Compress for the smallest file that stays visually within `target`.
 *
 * @param {Buffer} input  original image bytes
 * @param {import('./formats.js').FormatDef} format
 * @param {Object} opts
 * @param {string|number} opts.target  named target or a raw DSSIM ceiling
 * @param {number} [opts.effort]
 * @param {number} [opts.maxEdge]  downscale longest edge before encoding
 * @param {string} [opts.background]  flatten colour for alpha->opaque formats
 * @param {object} [opts.source]  shared pre-decoded source (see decodeSource)
 */
export async function searchByQuality(input, format, opts = {}) {
  const targetName = typeof opts.target === 'number' ? null : opts.target ?? 'high';
  const ceiling = typeof opts.target === 'number' ? opts.target : QUALITY_TARGETS[targetName];
  if (ceiling === undefined) throw new Error(`Unknown quality target: ${opts.target}`);

  const prepared = await preprocess(input, format, opts);
  const reference = prepared.reference;

  // Lossless short-circuit: no search, just encode once.
  if (ceiling === 0) {
    if (!format.canLossless) throw new Error(`${format.label} cannot encode losslessly`);
    const buffer = await format.encode(prepared.raw, {
      quality: 100,
      effort: opts.effort ?? format.defaultEffort,
      lossless: true,
    });
    return finalize(buffer, 0, prepared, input, 'lossless');
  }

  const finalEffort = opts.effort ?? format.defaultEffort;
  const searchEffort = Math.min(finalEffort, format.searchEffort ?? finalEffort);
  const seed = (targetName && QUALITY_SEED[targetName]?.[format.id]) ?? 70;

  const probe = async (quality) => {
    const buffer = await format.encode(prepared.raw, { quality, effort: searchEffort });
    const dssim = await compareToReference(reference, buffer);
    return { quality, buffer, size: buffer.length, dssim, dir: 'down' };
  };

  const { best, evaluated } = await bisect(
    probe,
    (c) => c.dssim <= ceiling,
    (a, b) => a.size < b.size,
    format.qualityRange,
    seed,
    {
      maxIters: opts.maxIters ?? 5,
      // "Near-optimal" = within the ceiling but close to it: lowering quality
      // further would breach it, so this is about the smallest safe file.
      goodEnough: (c) => c.dssim >= ceiling * 0.75,
      // Auto mode passes the best size found so far. A candidate that already
      // meets fidelity but is bigger than the current winner can't win — stop.
      beatSize: opts.beatSize,
    }
  );

  // If nothing hit the ceiling (e.g. a noisy source at a strict target), fall
  // back to the lowest-DSSIM probe so we still return the best available.
  const chosen = best ?? evaluated.reduce((a, b) => (a.dssim <= b.dssim ? a : b));

  // Re-encode the winner once at full effort. Higher effort only shrinks the
  // file and never raises DSSIM, so the perceptual guarantee holds.
  const final = await finalEncode(format, prepared.raw, chosen, finalEffort, searchEffort, reference);
  const result = finalize(final.buffer, final.dssim, prepared, input, `q${chosen.quality}`);
  result.targetMet = final.dssim <= ceiling;
  return result;
}

// ---------------------------------------------------------------------------
// Size-budget search
// ---------------------------------------------------------------------------

/**
 * Compress to fit within `targetBytes`. Quality-first; downscale only if the
 * budget can't be met at the format's minimum quality.
 *
 * @param {number} opts.targetBytes  hard ceiling in bytes
 */
export async function searchBySize(input, format, opts = {}) {
  const targetBytes = opts.targetBytes;
  if (!targetBytes || targetBytes <= 0) throw new Error('targetBytes must be positive');
  // Size mode searches at the FINAL effort (higher effort => smaller file), so
  // that we measure at the effort we ship and actually fill the budget rather
  // than sailing under it. No per-probe DSSIM here — encodes are the only cost.
  const finalEffort = opts.effort ?? format.defaultEffort;

  let prepared = await preprocess(input, format, opts);

  // Geometric downscale rounds: full, then 85% / 72% / 61% of the longest edge.
  const scales = [1, 0.85, 0.72, 0.61];
  let last = null;

  for (let round = 0; round < scales.length; round++) {
    if (round > 0) {
      prepared = await preprocess(input, format, {
        ...opts,
        source: undefined, // re-decode at the smaller size
        maxEdge: Math.round(prepared.baseLongestEdge * scales[round]),
      });
    }

    const probe = async (quality) => {
      const buffer = await format.encode(prepared.raw, { quality, effort: finalEffort });
      return { quality, buffer, size: buffer.length, dir: 'up' };
    };

    // Seed from a bytes-per-pixel estimate: assume file size scales roughly with
    // quality, start near where the budget likely lands. 55 is a decent middle.
    const { best, evaluated } = await bisect(
      probe,
      (c) => c.size <= targetBytes,
      (a, b) => a.size > b.size,
      format.qualityRange,
      55,
      // Filling 92%+ of the budget is a great result — stop hunting for the last
      // few bytes of a KB target that no one will notice.
      { goodEnough: (c) => c.size >= targetBytes * 0.92 }
    );

    if (best) {
      const dssim = await compareToReference(prepared.reference, best.buffer);
      const scaledNote = round === 0 ? `q${best.quality}` : `q${best.quality} @${Math.round(scales[round] * 100)}%`;
      return finalize(best.buffer, dssim, prepared, input, scaledNote);
    }

    const smallest = evaluated.reduce((a, b) => (a.size <= b.size ? a : b));
    if (!last || smallest.size < last.buffer.length) {
      last = { buffer: smallest.buffer, prepared, quality: smallest.quality, scale: scales[round] };
    }
  }

  // Even the smallest downscale + min quality overshot. Return the smallest and
  // report honestly that the target was not reachable.
  const dssim = await compareToReference(last.prepared.reference, last.buffer);
  const result = finalize(last.buffer, dssim, last.prepared, input, `q${last.quality} @${Math.round(last.scale * 100)}% (target not reachable)`);
  result.targetMet = false;
  return result;
}

// ---------------------------------------------------------------------------
// Shared decode / pre / post processing
// ---------------------------------------------------------------------------

/**
 * Decode the source ONCE into oriented raw pixels. compressAuto calls this and
 * hands the result to every format via opts.source, so a 5-format comparison
 * decodes the original a single time instead of five.
 *
 * @returns {Promise<{data:Buffer,width:number,height:number,channels:number,baseLongestEdge:number,hasAlpha:boolean}>}
 */
export async function decodeSource(input, opts = {}) {
  let img = sharp(input, { failOn: 'none' }).rotate(); // bake EXIF orientation
  const meta = await img.metadata();
  const baseLongestEdge = Math.max(meta.width || 1, meta.height || 1);

  if (opts.maxEdge && opts.maxEdge < baseLongestEdge) {
    img = img.resize(opts.maxEdge, opts.maxEdge, { fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' });
  }

  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return {
    data,
    width: info.width,
    height: info.height,
    channels: info.channels,
    baseLongestEdge,
    hasAlpha: info.channels === 4 || info.channels === 2,
  };
}

/**
 * Turn a decoded source into the exact raw pixels this format will encode
 * (flattening alpha for opaque-only formats) plus the metric reference built
 * from those same pixels. Both come from raw memory — no image re-encode.
 */
async function preprocess(input, format, opts) {
  let src = opts.source;
  // Re-decode when there's no shared source, or when this call needs a smaller
  // image than the shared source currently holds (size mode's downscale rounds).
  if (!src || (opts.maxEdge && opts.maxEdge < Math.max(src.width, src.height))) {
    src = await decodeSource(input, opts);
  }

  let raw = { data: src.data, width: src.width, height: src.height, channels: src.channels };

  // Flatten alpha for formats that can't hold it (JPEG). Do it in raw space.
  if (!format.alpha && src.hasAlpha) {
    const flat = await sharp(src.data, { raw: { width: src.width, height: src.height, channels: src.channels } })
      .flatten({ background: opts.background || '#ffffff' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    raw = { data: flat.data, width: flat.info.width, height: flat.info.height, channels: flat.info.channels };
  }

  const reference = await prepareReference(raw);

  return {
    raw, // { data, width, height, channels } — fed straight to the encoder
    reference, // CIELAB planes for the metric
    width: raw.width,
    height: raw.height,
    baseLongestEdge: src.baseLongestEdge,
    originalSize: input.length,
  };
}

/**
 * Re-encode the winning quality at full effort. Search runs at a cheaper effort
 * (format.searchEffort) because higher effort mostly costs time while only
 * shrinking the file, not changing which quality we'd pick. We pay for the size
 * win once, here, on the winner. If search already ran at the final effort, the
 * existing buffer is reused.
 */
async function finalEncode(format, raw, chosen, finalEffort, searchEffort, reference) {
  if (finalEffort === searchEffort) {
    const dssim = chosen.dssim ?? (await compareToReference(reference, chosen.buffer));
    return { buffer: chosen.buffer, dssim };
  }
  const buffer = await format.encode(raw, { quality: chosen.quality, effort: finalEffort });
  const dssim = await compareToReference(reference, buffer);
  return { buffer, dssim };
}

function finalize(buffer, dssim, prepared, originalInput, note) {
  return {
    buffer,
    size: buffer.length,
    dssim,
    score: visualScore(dssim),
    width: prepared.width,
    height: prepared.height,
    originalSize: originalInput.length,
    ratio: buffer.length / originalInput.length,
    savedBytes: originalInput.length - buffer.length,
    // Re-encoding an already-optimised source to a strict target can produce a
    // file BIGGER than the input. Real outcome, not a bug — but never hand back
    // a larger file silently, so flag it for the caller to offer keeping originals.
    grewLargerThanSource: buffer.length >= originalInput.length,
    note,
    targetMet: true,
  };
}
