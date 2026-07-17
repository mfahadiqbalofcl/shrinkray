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
 * Both share one idea: encoding is monotonic in the quality knob (higher
 * quality => bigger file and lower DSSIM), so binary search converges in
 * ~log2(range) ≈ 7 steps. We cache encodes by quality so the two ends of the
 * search never re-encode the same point, and we keep the best candidate seen
 * rather than trusting the final probe to be optimal.
 */

import { prepareReference, compareToReference, QUALITY_TARGETS, visualScore } from './metric.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Binary search over an integer quality range.
 * @param {(q:number)=>Promise<{buffer:Buffer, size:number, dssim?:number}>} probe
 * @param {(cand)=>boolean} satisfies  true if the candidate meets the constraint
 * @param {'higher-is-smaller'|'higher-is-bigger'} direction
 *   Which way "quality up" moves the thing we're bounding. For a size budget,
 *   quality up = bigger file, and when a probe *satisfies* (fits) we want to go
 *   higher. For a quality ceiling, quality up = lower DSSIM = satisfies, and we
 *   want to go lower to shrink the file. This flag encodes that asymmetry.
 * @param {[number,number]} range
 * @param {number} maxIters
 */
async function bisect(probe, satisfies, prefer, range, maxIters = 8) {
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

  let iters = 0;
  while (lo <= hi && iters < maxIters) {
    iters++;
    const mid = Math.floor((lo + hi) / 2);
    const cand = await at(mid);
    const ok = satisfies(cand);

    if (ok) {
      // `prefer` decides which satisfying candidate is "better": smaller file
      // (quality search) or bigger-but-still-fitting file (size search).
      if (!best || prefer(cand, best)) best = cand;
    }

    // Move toward the boundary. If satisfied and we prefer smaller output, or
    // not satisfied and we need higher quality, the direction depends on how
    // quality relates to the constraint — captured by whether `ok` holds.
    if (cand.dir === 'down' ? ok : !ok) {
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return { best, evaluated: [...seen.values()], iterations: iters };
}

/**
 * Compress for the smallest file that stays visually within `target`.
 *
 * @param {Buffer} input  original image bytes
 * @param {import('./formats.js').FormatDef} format
 * @param {Object} opts
 * @param {string|number} opts.target  named target ('visually-lossless'…) or a raw DSSIM ceiling
 * @param {number} [opts.effort]
 * @param {number} [opts.maxEdge]  downscale longest edge before encoding
 * @param {string} [opts.background]  flatten colour for alpha->opaque formats
 */
export async function searchByQuality(input, format, opts = {}) {
  const ceiling =
    typeof opts.target === 'number' ? opts.target : QUALITY_TARGETS[opts.target ?? 'high'];
  if (ceiling === undefined) throw new Error(`Unknown quality target: ${opts.target}`);

  const prepared = await preprocess(input, format, opts);
  const reference = await prepareReference(prepared.referencePng);

  // Lossless short-circuit: no search, just encode once.
  if (ceiling === 0) {
    if (!format.canLossless) throw new Error(`${format.label} cannot encode losslessly`);
    const buffer = await format.encode(prepared.pipelineInput, {
      quality: 100,
      effort: opts.effort ?? format.defaultEffort,
      lossless: true,
    });
    return finalize(buffer, 0, prepared, input, 'lossless');
  }

  const finalEffort = opts.effort ?? format.defaultEffort;
  const searchEffort = Math.min(finalEffort, format.searchEffort ?? finalEffort);

  const probe = async (quality) => {
    const buffer = await format.encode(prepared.pipelineInput, { quality, effort: searchEffort });
    const dssim = await compareToReference(reference, buffer);
    return { quality, buffer, size: buffer.length, dssim, dir: 'down' };
  };

  // Satisfy = within the perceptual ceiling. Among satisfying candidates we
  // prefer the smallest file. Direction 'down': when a candidate satisfies we
  // push quality lower to try to shrink further.
  const { best, evaluated } = await bisect(
    probe,
    (c) => c.dssim <= ceiling,
    (a, b) => a.size < b.size,
    format.qualityRange
  );

  // If nothing hit the ceiling (rare — e.g. a noisy source at a strict target),
  // fall back to the highest-quality probe we took, so we still return something.
  const chosen =
    best ??
    evaluated.reduce((a, b) => (a.dssim <= b.dssim ? a : b));

  // Re-encode the winning quality once at full effort. Higher effort only
  // shrinks the file and never raises DSSIM, so the perceptual guarantee holds.
  const final = await finalEncode(format, prepared.pipelineInput, chosen, finalEffort, searchEffort, reference);
  const result = finalize(final.buffer, final.dssim, prepared, input, `q${chosen.quality}`);

  // Report honestly whether we actually reached the fidelity target. Some
  // formats (notably WebP/JPEG at a strict "visually-lossless" ceiling) top out
  // at q100 without meeting it; the UI uses this to suggest AVIF instead.
  result.targetMet = final.dssim <= ceiling;
  return result;
}

/**
 * Compress to fit within `targetBytes`. Quality-first; downscale only if the
 * byte budget can't be met at the format's minimum quality.
 *
 * @param {number} opts.targetBytes  hard ceiling in bytes
 * @param {number} [opts.tolerance]  accept files within this fraction under target (default 0.06)
 */
export async function searchBySize(input, format, opts = {}) {
  const targetBytes = opts.targetBytes;
  if (!targetBytes || targetBytes <= 0) throw new Error('targetBytes must be positive');
  // Size mode searches at the FINAL effort, unlike quality mode. A cheaper
  // search effort would find a quality that fits the budget at that effort, but
  // the final higher-effort encode is smaller — so we'd sail well under budget
  // at needlessly low quality (mozjpeg alone shrinks JPEG ~30%). Here the goal
  // is to fill the budget, so we must measure at the effort we ship. No
  // per-probe DSSIM is computed in this mode, so the encodes are the only cost.
  const finalEffort = opts.effort ?? format.defaultEffort;

  let prepared = await preprocess(input, format, opts);
  let reference = await prepareReference(prepared.referencePng);

  // Up to 4 downscale rounds: full, then 85%/72%/61% of the longest edge.
  // Geometric so each round meaningfully cuts pixels (and therefore floor size).
  const scales = [1, 0.85, 0.72, 0.61];
  let last = null;

  for (let round = 0; round < scales.length; round++) {
    if (round > 0) {
      const factor = scales[round];
      prepared = await preprocess(input, format, {
        ...opts,
        maxEdge: Math.round(prepared.baseLongestEdge * factor),
      });
      reference = await prepareReference(prepared.referencePng);
    }

    const probe = async (quality) => {
      const buffer = await format.encode(prepared.pipelineInput, { quality, effort: finalEffort });
      return { quality, buffer, size: buffer.length, dir: 'up' };
    };

    // Satisfy = fits the budget. Among fitting candidates prefer the LARGEST
    // (best quality that still fits). Direction 'up': a fitting candidate lets
    // us push quality higher.
    const { best, evaluated } = await bisect(
      probe,
      (c) => c.size <= targetBytes,
      (a, b) => a.size > b.size,
      format.qualityRange
    );

    if (best) {
      const dssim = await compareToReference(reference, best.buffer);
      const scaledNote = round === 0 ? `q${best.quality}` : `q${best.quality} @${Math.round(scales[round] * 100)}%`;
      return finalize(best.buffer, dssim, prepared, input, scaledNote);
    }

    // Nothing fit even at min quality. Remember the smallest attempt for the
    // "impossible target" fallback, then downscale and retry.
    const smallest = evaluated.reduce((a, b) => (a.size <= b.size ? a : b));
    if (!last || smallest.size < last.buffer.length) {
      last = { buffer: smallest.buffer, prepared, reference, quality: smallest.quality, scale: scales[round] };
    }
  }

  // Even the most aggressive downscale + min quality overshot the budget.
  // Return the smallest thing we produced and let the caller report honestly.
  const dssim = await compareToReference(last.reference, last.buffer);
  const result = finalize(last.buffer, dssim, last.prepared, input, `q${last.quality} @${Math.round(last.scale * 100)}% (target not reachable)`);
  result.targetMet = false;
  return result;
}

// ---------------------------------------------------------------------------
// Shared pre/post processing
// ---------------------------------------------------------------------------

import sharp from 'sharp';

/**
 * Re-encode the winning quality at full effort. During search we encode at a
 * cheaper effort (see format.searchEffort) because higher effort costs a lot of
 * time while only shrinking the file, not changing which quality value we'd
 * pick. This is where we pay for that final size win — once, on the winner.
 *
 * If search already ran at the final effort (searchEffort === finalEffort), we
 * reuse the buffer we have and skip a redundant encode.
 */
async function finalEncode(format, pipelineInput, chosen, finalEffort, searchEffort, reference) {
  if (finalEffort === searchEffort) {
    const dssim = chosen.dssim ?? (await compareToReference(reference, chosen.buffer));
    return { buffer: chosen.buffer, dssim };
  }
  const buffer = await format.encode(pipelineInput, { quality: chosen.quality, effort: finalEffort });
  const dssim = await compareToReference(reference, buffer);
  return { buffer, dssim };
}

/**
 * Normalise orientation, optionally downscale, flatten alpha for opaque-only
 * formats, and produce both the pipeline input (fed to the encoder) and a
 * lossless PNG reference (fed to the metric) at the SAME pixel dimensions —
 * so DSSIM measures codec loss, not a resize we did to the reference.
 */
async function preprocess(input, format, opts) {
  let img = sharp(input, { failOn: 'none' }).rotate(); // bake EXIF orientation
  const meta = await img.metadata();
  const baseLongestEdge = Math.max(meta.width, meta.height);

  if (opts.maxEdge && opts.maxEdge < baseLongestEdge) {
    img = img.resize(opts.maxEdge, opts.maxEdge, { fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' });
  }

  if (!format.alpha) {
    img = img.flatten({ background: opts.background || '#ffffff' });
  }

  // Materialise once as raw pixels so encoder and metric share identical input.
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const pipelineInput = await sharp(data, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  })
    .png()
    .toBuffer();

  return {
    pipelineInput, // PNG carrying the exact pixels to encode
    referencePng: pipelineInput, // same bytes; the metric decodes it as ground truth
    width: info.width,
    height: info.height,
    baseLongestEdge,
    originalSize: input.length,
  };
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
    // Re-encoding an already-optimised source (often an existing JPEG/WebP) to a
    // strict fidelity target can produce a file BIGGER than the input. That's a
    // real outcome, not a bug — but a compressor must never quietly hand back a
    // larger file, so we flag it and let the caller offer to keep the original.
    grewLargerThanSource: buffer.length >= originalInput.length,
    note,
    targetMet: true,
  };
}
