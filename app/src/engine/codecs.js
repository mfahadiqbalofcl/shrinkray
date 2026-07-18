/**
 * Encoder registry over the jSquash WASM codecs. Each codec is dynamically
 * imported the first time it's used, so a visitor who only makes WebP never
 * downloads the (larger) AVIF WASM. The rest of the app treats every format the
 * same: encode(imageData, { quality, effort }) -> ArrayBuffer.
 */

const loaders = {
  jpeg: () => import('@jsquash/jpeg'),
  webp: () => import('@jsquash/webp'),
  avif: () => import('@jsquash/avif'),
  png: () => import('@jsquash/png'),
};
const cache = new Map();
async function mod(id) {
  if (!cache.has(id)) cache.set(id, loaders[id]());
  return cache.get(id);
}

/**
 * @typedef {Object} FormatDef
 * @property {string} id
 * @property {string} label
 * @property {string} ext
 * @property {string} mime
 * @property {boolean} alpha       keeps transparency
 * @property {boolean} lossy       has a quality knob
 * @property {[number,number]} quality  search bounds
 */
export const FORMATS = {
  avif: { id: 'avif', label: 'AVIF', ext: 'avif', mime: 'image/avif', alpha: true, lossy: true, quality: [1, 100] },
  webp: { id: 'webp', label: 'WebP', ext: 'webp', mime: 'image/webp', alpha: true, lossy: true, quality: [1, 100] },
  jpeg: { id: 'jpeg', label: 'JPEG', ext: 'jpg', mime: 'image/jpeg', alpha: false, lossy: true, quality: [1, 100] },
  png: { id: 'png', label: 'PNG', ext: 'png', mime: 'image/png', alpha: true, lossy: false, quality: [100, 100] },
};

/**
 * Encode ImageData to a format. `effort` maps to AVIF speed (0 slow/small,
 * 10 fast); we invert it so higher effort = slower/smaller like the rest of the
 * app. Returns an ArrayBuffer.
 */
export async function encode(imageData, format, { quality = 75, effort = 4 } = {}) {
  const m = await mod(format);
  switch (format) {
    case 'jpeg':
      return m.encode(imageData, { quality });
    case 'webp':
      return m.encode(imageData, { quality, method: clamp(effort, 0, 6) });
    case 'avif': {
      // jSquash avif: quality 0-100, speed 0(slow)-10(fast). Map effort 0-9 -> speed.
      const speed = clamp(10 - Math.round(effort), 0, 10);
      return m.encode(imageData, { quality, speed });
    }
    case 'png':
      return m.encode(imageData); // lossless
    default:
      throw new Error(`Unknown format: ${format}`);
  }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
