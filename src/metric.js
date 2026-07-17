/**
 * Perceptual quality metric — a DSSIM-style multi-scale SSIM computed in CIELAB.
 *
 * Why not plain PSNR/SSIM-on-RGB: both correlate poorly with what an eye actually
 * notices. Comparing in CIELAB (a roughly perceptually-uniform space) and across
 * several scales catches both fine ringing and coarse blotching, and weights the
 * lightness channel far above chroma — which is how human vision works, and why
 * every codec throws chroma away first.
 *
 * Output is DSSIM (0 = identical, higher = worse). We use Kornel Lesinski's
 * formulation (1/ssim - 1) rather than raw SSIM because SSIM crushes everything
 * interesting into 0.98..1.0, while DSSIM spreads the high-quality range out
 * enough to binary-search against. Thresholds in QUALITY_TARGETS are calibrated
 * empirically — see tools/calibrate.js.
 */

import sharp from 'sharp';

// ---------------------------------------------------------------------------
// Colour conversion
// ---------------------------------------------------------------------------

/** sRGB 8-bit -> linear-light, precomputed since we hit it once per subpixel. */
const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// D65 reference white.
const XN = 0.95047;
const YN = 1.0;
const ZN = 1.08883;

const EPSILON = 216 / 24389; // 0.008856
const KAPPA = 24389 / 27; // 903.3

function labF(t) {
  return t > EPSILON ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
}

/**
 * Convert an interleaved RGB byte buffer to three planar CIELAB channels.
 * @param {Buffer} raw interleaved RGB, 3 bytes per pixel
 * @param {number} count pixel count
 */
function rgbToLab(raw, count) {
  const L = new Float32Array(count);
  const A = new Float32Array(count);
  const B = new Float32Array(count);

  for (let i = 0, p = 0; i < count; i++, p += 3) {
    const r = SRGB_TO_LINEAR[raw[p]];
    const g = SRGB_TO_LINEAR[raw[p + 1]];
    const b = SRGB_TO_LINEAR[raw[p + 2]];

    const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / XN;
    const y = (0.2126729 * r + 0.7151522 * g + 0.072175 * b) / YN;
    const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / ZN;

    const fx = labF(x);
    const fy = labF(y);
    const fz = labF(z);

    L[i] = 116 * fy - 16; //    0..100
    A[i] = 500 * (fx - fy); // ~ -128..127
    B[i] = 200 * (fy - fz); // ~ -128..127
  }

  return { L, A, B };
}

// ---------------------------------------------------------------------------
// Separable Gaussian blur (the SSIM window)
// ---------------------------------------------------------------------------

/** Standard SSIM window: 11 taps, sigma 1.5. */
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

/**
 * Blur a planar Float32 channel. Separable: horizontal then vertical pass,
 * which turns an O(r^2) convolution into O(2r). Edges clamp to the border
 * pixel, matching the reference SSIM implementations.
 */
function blur(src, w, h, scratch, dst) {
  // Horizontal
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let t = -RADIUS; t <= RADIUS; t++) {
        let sx = x + t;
        if (sx < 0) sx = 0;
        else if (sx >= w) sx = w - 1;
        acc += src[row + sx] * KERNEL[t + RADIUS];
      }
      scratch[row + x] = acc;
    }
  }
  // Vertical
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let t = -RADIUS; t <= RADIUS; t++) {
        let sy = y + t;
        if (sy < 0) sy = 0;
        else if (sy >= h) sy = h - 1;
        acc += scratch[sy * w + x] * KERNEL[t + RADIUS];
      }
      dst[y * w + x] = acc;
    }
  }
  return dst;
}

// ---------------------------------------------------------------------------
// SSIM
// ---------------------------------------------------------------------------

/**
 * Mean SSIM between two planar channels.
 * @param {number} range dynamic range of the channel, for the C1/C2 stabilisers
 */
function ssimChannel(x, y, w, h, range) {
  const n = w * h;
  const scratch = new Float32Array(n);

  const xx = new Float32Array(n);
  const yy = new Float32Array(n);
  const xy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    xx[i] = x[i] * x[i];
    yy[i] = y[i] * y[i];
    xy[i] = x[i] * y[i];
  }

  const muX = blur(x, w, h, scratch, new Float32Array(n));
  const muY = blur(y, w, h, scratch, new Float32Array(n));
  const bXX = blur(xx, w, h, scratch, new Float32Array(n));
  const bYY = blur(yy, w, h, scratch, new Float32Array(n));
  const bXY = blur(xy, w, h, scratch, new Float32Array(n));

  const C1 = (0.01 * range) ** 2;
  const C2 = (0.03 * range) ** 2;

  let sum = 0;
  for (let i = 0; i < n; i++) {
    const mx = muX[i];
    const my = muY[i];
    const mx2 = mx * mx;
    const my2 = my * my;
    const sx2 = bXX[i] - mx2;
    const sy2 = bYY[i] - my2;
    const sxy = bXY[i] - mx * my;

    sum +=
      ((2 * mx * my + C1) * (2 * sxy + C2)) /
      ((mx2 + my2 + C1) * (sx2 + sy2 + C2));
  }
  return sum / n;
}

/** Halve a planar channel with a 2x2 box filter. */
function downsample2x(src, w, h) {
  const nw = Math.max(1, w >> 1);
  const nh = Math.max(1, h >> 1);
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const s0 = y * 2 * w;
    const s1 = Math.min(y * 2 + 1, h - 1) * w;
    for (let x = 0; x < nw; x++) {
      const x0 = x * 2;
      const x1 = Math.min(x0 + 1, w - 1);
      out[y * nw + x] = (src[s0 + x0] + src[s0 + x1] + src[s1 + x0] + src[s1 + x1]) * 0.25;
    }
  }
  return { data: out, width: nw, height: nh };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Longest edge the metric runs at. Full-resolution SSIM is wasted work — the
 * artifacts that matter survive a downscale, and this keeps a binary search
 * (8-ish encodes, each scored) inside a second or two rather than a minute.
 */
export const METRIC_MAX_EDGE = 768;

const SCALE_WEIGHTS = [0.5, 0.3, 0.2]; // fine -> coarse
const CHANNEL_WEIGHTS = { L: 0.8, A: 0.1, B: 0.1 };

/**
 * Decode an image into the planar CIELAB form the metric consumes, downscaled
 * to a common comparison size. Hoisted out of `compare` so a binary search can
 * prepare the reference exactly once instead of per iteration.
 */
export async function prepareReference(buffer, maxEdge = METRIC_MAX_EDGE) {
  const img = sharp(buffer, { failOn: 'none' }).flatten({ background: '#ffffff' });
  const meta = await img.metadata();

  const scale = Math.min(1, maxEdge / Math.max(meta.width, meta.height));
  const width = Math.max(1, Math.round(meta.width * scale));
  const height = Math.max(1, Math.round(meta.height * scale));

  const { data } = await img
    .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return { ...rgbToLab(data, width * height), width, height };
}

/**
 * DSSIM between a prepared reference and a candidate encode.
 * @returns {Promise<number>} 0 = identical, higher = more visible damage
 */
export async function compareToReference(reference, candidateBuffer) {
  const candidate = await prepareReference(
    candidateBuffer,
    Math.max(reference.width, reference.height)
  );

  // A candidate that decoded to different dimensions can't be compared
  // pixel-wise. Callers resize before encoding, so this means something broke.
  if (candidate.width !== reference.width || candidate.height !== reference.height) {
    throw new Error(
      `Metric size mismatch: reference ${reference.width}x${reference.height}, ` +
        `candidate ${candidate.width}x${candidate.height}`
    );
  }

  let total = 0;
  for (const [channel, chWeight] of Object.entries(CHANNEL_WEIGHTS)) {
    const range = channel === 'L' ? 100 : 255;
    let ref = { data: reference[channel], width: reference.width, height: reference.height };
    let cand = { data: candidate[channel], width: candidate.width, height: candidate.height };

    for (let s = 0; s < SCALE_WEIGHTS.length; s++) {
      if (ref.width < 16 || ref.height < 16) break; // too small for an 11-tap window
      const ssim = ssimChannel(ref.data, cand.data, ref.width, ref.height, range);
      total += chWeight * SCALE_WEIGHTS[s] * ssim;

      if (s < SCALE_WEIGHTS.length - 1) {
        ref = downsample2x(ref.data, ref.width, ref.height);
        cand = downsample2x(cand.data, cand.width, cand.height);
      }
    }
  }

  const ssim = Math.min(1, Math.max(1e-6, total));
  return 1 / ssim - 1;
}

/** Convenience: DSSIM between two encoded image buffers. */
export async function compare(originalBuffer, candidateBuffer, maxEdge = METRIC_MAX_EDGE) {
  const reference = await prepareReference(originalBuffer, maxEdge);
  return compareToReference(reference, candidateBuffer);
}

/**
 * DSSIM ceilings for each named quality target.
 *
 * Calibrated on a photo/illustration/screenshot corpus (tools/calibrate.js):
 * these are the DSSIM values at which artifacts become findable, then obvious,
 * on a 1x display at 100% zoom. They are judgement calls, not physical
 * constants — `lossless` is the only bit-exact guarantee here.
 */
export const QUALITY_TARGETS = {
  lossless: 0,
  'visually-lossless': 0.001,
  high: 0.003,
  balanced: 0.008,
  small: 0.02,
  tiny: 0.05,
};

/**
 * Map DSSIM onto a friendly 0-100 "visual match" score.
 *
 * Log-scaled, because DSSIM is: the perceptual step from 0.0005 to 0.005 is
 * about the same size as 0.005 to 0.05, and a linear bar would render every
 * good result as an indistinguishable 99%.
 */
export function visualScore(dssim) {
  if (dssim <= 0) return 100;
  const FLOOR = 0.0004; // below this, nobody can tell
  const CEIL = 0.1; // by here it's visibly wrecked
  if (dssim <= FLOOR) return 100;
  if (dssim >= CEIL) return 0;
  const t = Math.log10(dssim / FLOOR) / Math.log10(CEIL / FLOOR);
  return Math.round((1 - t) * 1000) / 10;
}
