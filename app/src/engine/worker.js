/**
 * Compression worker. Decoding, WASM encoding, and the perceptual metric are all
 * CPU-heavy, so they run here, off the main thread. One of these runs per core;
 * the pool feeds them images. Results transfer their bytes back with zero copy.
 */

import { compress, compressAuto, probeOnce } from './compress.js';
import { encode } from './codecs.js';

const OPS = { auto: compressAuto, single: compress, probe: probeOnce };

self.onmessage = async (e) => {
  const { id, op, input, inputType, opts } = e.data;
  try {
    // Warm a codec: download + compile its WASM ahead of the first real job,
    // so the first compression isn't stalled waiting on a network fetch.
    if (op === 'warm') {
      await encode(new ImageData(2, 2), opts.format, { quality: 50, effort: 4 });
      self.postMessage({ id, ok: true, result: { warmed: opts.format } });
      return;
    }
    const fn = OPS[op] || compress;
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
