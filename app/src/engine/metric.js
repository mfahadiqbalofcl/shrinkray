/**
 * Browser bridge to the shared DSSIM core. Turns an image (ImageData or encoded
 * bytes) into the CIELAB reference the metric compares, at a fixed small size so
 * a quality search stays fast.
 */

import { rgbToLab, dssim, METRIC_MAX_EDGE } from '../../../core/dssim.js';
import { decode, decodeScaled, resizeImageData } from './image.js';

/** Build a CIELAB reference from ImageData, downscaled to the metric size. */
export async function referenceFromImageData(imageData, maxEdge = METRIC_MAX_EDGE) {
  const scaled = await resizeImageData(imageData, maxEdge);
  const { width, height, data } = scaled;
  return { ...rgbToLab(data, width * height, 4), width, height };
}

/** Build a CIELAB reference straight from encoded bytes (decode + downscale). */
export async function referenceFromBytes(buffer, mime, maxEdge = METRIC_MAX_EDGE) {
  const scaled = await decodeScaled(buffer, mime, maxEdge);
  const { width, height, data } = scaled;
  return { ...rgbToLab(data, width * height, 4), width, height };
}

/** DSSIM between a prepared reference and an encoded candidate. */
export async function compareToReference(reference, candidateBuffer, mime) {
  const cand = await referenceFromBytes(candidateBuffer, mime, Math.max(reference.width, reference.height));
  return dssim(reference, cand);
}

export { dssim, decode };
export { QUALITY_TARGETS, visualScore } from '../../../core/dssim.js';
