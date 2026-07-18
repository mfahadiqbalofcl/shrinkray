/**
 * Node-side perceptual metric: a thin sharp wrapper over the shared DSSIM core.
 *
 * The actual math (CIELAB conversion, multi-scale SSIM, the thresholds) lives in
 * ../core/dssim.js so the Node server and the browser app score images
 * identically. Here we just use sharp to turn an image into the raw pixels the
 * core consumes.
 */

import sharp from 'sharp';
import { rgbToLab, dssim, visualScore, QUALITY_TARGETS, METRIC_MAX_EDGE } from '../core/dssim.js';

export { visualScore, QUALITY_TARGETS, METRIC_MAX_EDGE };

/**
 * Wrap a source as a sharp instance. Accepts an encoded Buffer OR a raw-pixel
 * descriptor `{ data, width, height, channels }` (the fast path the search uses).
 */
function asSharp(source) {
  if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
    return sharp(source, { failOn: 'none' });
  }
  return sharp(source.data, {
    failOn: 'none',
    raw: { width: source.width, height: source.height, channels: source.channels },
  });
}

/**
 * Decode/resize a source into the planar CIELAB reference the metric consumes,
 * downscaled to a common comparison size so a search stays fast.
 * @param {Buffer|{data:Buffer,width:number,height:number,channels:number}} source
 */
export async function prepareReference(source, maxEdge = METRIC_MAX_EDGE) {
  const img = asSharp(source).flatten({ background: '#ffffff' });
  const meta = await img.metadata();

  const scale = Math.min(1, maxEdge / Math.max(meta.width, meta.height));
  const width = Math.max(1, Math.round(meta.width * scale));
  const height = Math.max(1, Math.round(meta.height * scale));

  const { data } = await img
    .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return { ...rgbToLab(data, width * height, 3), width, height };
}

/** DSSIM between a prepared reference and a candidate encode. */
export async function compareToReference(reference, candidateBuffer) {
  const candidate = await prepareReference(candidateBuffer, Math.max(reference.width, reference.height));
  return dssim(reference, candidate);
}

/** Convenience: DSSIM between two encoded image buffers. */
export async function compare(originalBuffer, candidateBuffer, maxEdge = METRIC_MAX_EDGE) {
  const reference = await prepareReference(originalBuffer, maxEdge);
  return compareToReference(reference, candidateBuffer);
}
