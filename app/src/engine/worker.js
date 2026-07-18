/**
 * Compression worker. Decoding, WASM encoding, and the perceptual metric are all
 * CPU-heavy, so they run here, off the main thread. One of these runs per core;
 * the pool feeds them images. Results transfer their bytes back with zero copy.
 */

import { compress, compressAuto } from './compress.js';

self.onmessage = async (e) => {
  const { id, op, input, inputType, opts } = e.data;
  try {
    const fn = op === 'auto' ? compressAuto : compress;
    const result = await fn(input, inputType, opts);

    // Strip ArrayBuffers off the candidate metadata; only the winner's bytes go back.
    const transfers = [];
    const shape = (r) => {
      if (!r || r.error) return r;
      const { bytes, ...meta } = r;
      if (bytes) { transfers.push(bytes); return { ...meta, bytes }; }
      return meta;
    };
    let payload;
    if (op === 'auto') {
      payload = { best: shape(result.best), candidates: result.candidates.map((c) => shape({ ...c, bytes: undefined })) };
    } else {
      payload = shape(result);
    }
    self.postMessage({ id, ok: true, result: payload }, transfers);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message });
  }
};
