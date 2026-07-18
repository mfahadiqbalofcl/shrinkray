/**
 * Decode and resize using the browser itself. `createImageBitmap` decodes every
 * format the browser supports (JPEG, PNG, WebP, AVIF, GIF) fast and off the main
 * thread, and can resample in one call. We only reach for a WASM codec to ENCODE
 * (browsers can't write AVIF/WebP-lossless well), never to decode.
 */

/** Decode encoded bytes to ImageData (RGBA). */
export async function decode(buffer, type = '') {
  const blob = buffer instanceof Blob ? buffer : new Blob([buffer], { type });
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const data = bitmapToImageData(bitmap);
  bitmap.close();
  return data;
}

/** Decode + downscale so the longest edge is <= maxEdge (skips if already small). */
export async function decodeScaled(buffer, type, maxEdge) {
  const blob = buffer instanceof Blob ? buffer : new Blob([buffer], { type });
  const probe = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const { width, height } = probe;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  if (scale >= 1) { const d = bitmapToImageData(probe); probe.close(); return d; }
  probe.close();
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image', resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
  const data = bitmapToImageData(bitmap);
  bitmap.close();
  return data;
}

/** Resize existing ImageData to a max longest edge (high quality). */
export async function resizeImageData(imageData, maxEdge) {
  const { width, height } = imageData;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  if (scale >= 1) return imageData;
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const bitmap = await createImageBitmap(imageData, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
  const out = bitmapToImageData(bitmap);
  bitmap.close();
  return out;
}

/** Flatten transparency onto a background colour (for JPEG, which has no alpha). */
export async function flatten(imageData, background = '#ffffff') {
  const { width, height } = imageData;
  const bitmap = await createImageBitmap(imageData);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0); // composites the image over the fill
  bitmap.close();
  return ctx.getImageData(0, 0, width, height);
}

/** Does this image have any non-opaque pixel? */
export function hasAlpha(imageData) {
  const d = imageData.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return true;
  return false;
}

function bitmapToImageData(bitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}
