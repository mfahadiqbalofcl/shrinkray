/**
 * Shared perceptual metric — a DSSIM-style multi-scale SSIM in CIELAB.
 *
 * Pure JavaScript, no platform dependencies, so the exact same code runs in the
 * Node server (fed pixels by sharp) and in the browser app (fed pixels by a
 * canvas). This is the "compress without losing quality" core: it measures how
 * different a candidate encode looks from the original, weighting lightness far
 * above chroma the way human vision does.
 *
 * Output is DSSIM (0 = identical, higher = worse), using Kornel Lesinski's
 * 1/ssim - 1 formulation, which spreads the high-quality range out enough to
 * binary-search against. Thresholds in QUALITY_TARGETS are calibrated judgement
 * calls (see tools/calibrate.js).
 */

// --- sRGB -> linear, precomputed ---
const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const XN = 0.95047, YN = 1.0, ZN = 1.08883;
const EPSILON = 216 / 24389;
const KAPPA = 24389 / 27;
const labF = (t) => (t > EPSILON ? Math.cbrt(t) : (KAPPA * t + 16) / 116);

/**
 * Interleaved pixel bytes -> three planar CIELAB channels.
 * @param {Uint8Array|Uint8ClampedArray|Buffer} raw interleaved pixels
 * @param {number} count pixel count
 * @param {number} channels 3 (RGB) or 4 (RGBA, e.g. canvas ImageData)
 */
export function rgbToLab(raw, count, channels = 3) {
  const L = new Float32Array(count);
  const A = new Float32Array(count);
  const B = new Float32Array(count);
  for (let i = 0, p = 0; i < count; i++, p += channels) {
    const r = SRGB_TO_LINEAR[raw[p]];
    const g = SRGB_TO_LINEAR[raw[p + 1]];
    const b = SRGB_TO_LINEAR[raw[p + 2]];
    const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / XN;
    const y = (0.2126729 * r + 0.7151522 * g + 0.072175 * b) / YN;
    const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / ZN;
    const fx = labF(x), fy = labF(y), fz = labF(z);
    L[i] = 116 * fy - 16;
    A[i] = 500 * (fx - fy);
    B[i] = 200 * (fy - fz);
  }
  return { L, A, B };
}

// --- separable Gaussian blur (the SSIM window: 11 taps, sigma 1.5) ---
function gaussianKernel(sigma = 1.5, radius = 5) {
  const size = radius * 2 + 1;
  const k = new Float32Array(size);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const d = i - radius;
    k[i] = Math.exp(-(d * d) / (2 * sigma * sigma));
    sum += k[i];
  }
  for (let i = 0; i < size; i++) k[i] /= sum;
  return k;
}
const KERNEL = gaussianKernel();
const RADIUS = (KERNEL.length - 1) / 2;

function blur(src, w, h, scratch, dst) {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let t = -RADIUS; t <= RADIUS; t++) {
        let sx = x + t;
        if (sx < 0) sx = 0; else if (sx >= w) sx = w - 1;
        acc += src[row + sx] * KERNEL[t + RADIUS];
      }
      scratch[row + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let t = -RADIUS; t <= RADIUS; t++) {
        let sy = y + t;
        if (sy < 0) sy = 0; else if (sy >= h) sy = h - 1;
        acc += scratch[sy * w + x] * KERNEL[t + RADIUS];
      }
      dst[y * w + x] = acc;
    }
  }
  return dst;
}

function ssimChannel(x, y, w, h, range) {
  const n = w * h;
  const scratch = new Float32Array(n);
  const xx = new Float32Array(n), yy = new Float32Array(n), xy = new Float32Array(n);
  for (let i = 0; i < n; i++) { xx[i] = x[i] * x[i]; yy[i] = y[i] * y[i]; xy[i] = x[i] * y[i]; }
  const muX = blur(x, w, h, scratch, new Float32Array(n));
  const muY = blur(y, w, h, scratch, new Float32Array(n));
  const bXX = blur(xx, w, h, scratch, new Float32Array(n));
  const bYY = blur(yy, w, h, scratch, new Float32Array(n));
  const bXY = blur(xy, w, h, scratch, new Float32Array(n));
  const C1 = (0.01 * range) ** 2, C2 = (0.03 * range) ** 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const mx = muX[i], my = muY[i];
    const mx2 = mx * mx, my2 = my * my;
    const sx2 = bXX[i] - mx2, sy2 = bYY[i] - my2, sxy = bXY[i] - mx * my;
    sum += ((2 * mx * my + C1) * (2 * sxy + C2)) / ((mx2 + my2 + C1) * (sx2 + sy2 + C2));
  }
  return sum / n;
}

function downsample2x(src, w, h) {
  const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const s0 = y * 2 * w;
    const s1 = Math.min(y * 2 + 1, h - 1) * w;
    for (let x = 0; x < nw; x++) {
      const x0 = x * 2, x1 = Math.min(x0 + 1, w - 1);
      out[y * nw + x] = (src[s0 + x0] + src[s0 + x1] + src[s1 + x0] + src[s1 + x1]) * 0.25;
    }
  }
  return { data: out, width: nw, height: nh };
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/** Longest edge the metric runs at. Artifacts that matter survive a downscale. */
export const METRIC_MAX_EDGE = 640;

const SCALE_WEIGHTS = [0.5, 0.3, 0.2];
const CHANNEL_WEIGHTS = { L: 0.8, A: 0.1, B: 0.1 };

/**
 * DSSIM between two prepared CIELAB references of the SAME dimensions.
 * @param {{L,A,B,width,height}} ref
 * @param {{L,A,B,width,height}} cand
 * @returns {number} 0 = identical, higher = more visible damage
 */
export function dssim(ref, cand) {
  if (cand.width !== ref.width || cand.height !== ref.height) {
    throw new Error(`Metric size mismatch: ${ref.width}x${ref.height} vs ${cand.width}x${cand.height}`);
  }
  let total = 0;
  for (const [channel, chWeight] of Object.entries(CHANNEL_WEIGHTS)) {
    const range = channel === 'L' ? 100 : 255;
    let r = { data: ref[channel], width: ref.width, height: ref.height };
    let c = { data: cand[channel], width: cand.width, height: cand.height };
    for (let s = 0; s < SCALE_WEIGHTS.length; s++) {
      if (r.width < 16 || r.height < 16) break;
      total += chWeight * SCALE_WEIGHTS[s] * ssimChannel(r.data, c.data, r.width, r.height, range);
      if (s < SCALE_WEIGHTS.length - 1) {
        r = downsample2x(r.data, r.width, r.height);
        c = downsample2x(c.data, c.width, c.height);
      }
    }
  }
  const ssim = Math.min(1, Math.max(1e-6, total));
  return 1 / ssim - 1;
}

/**
 * DSSIM ceilings per named fidelity target. Calibrated on a mixed photo /
 * illustration / screenshot corpus at METRIC_MAX_EDGE.
 */
export const QUALITY_TARGETS = {
  lossless: 0,
  'visually-lossless': 0.0008,
  high: 0.0024,
  balanced: 0.0065,
  small: 0.016,
  tiny: 0.04,
};

/** Map DSSIM onto a friendly 0-100 "visual match" score (log-scaled). */
export function visualScore(d) {
  if (d <= 0) return 100;
  const FLOOR = 0.0003, CEIL = 0.08;
  if (d <= FLOOR) return 100;
  if (d >= CEIL) return 0;
  const t = Math.log10(d / FLOOR) / Math.log10(CEIL / FLOOR);
  return Math.round((1 - t) * 1000) / 10;
}
