/**
 * Pool worker. One of these runs per CPU core; each processes whole compression
 * jobs independently. This is what turns a serial batch into a parallel one —
 * the pure-JS perceptual metric is CPU-bound and would otherwise pin a single
 * core and serialize the whole queue.
 *
 * sharp is pinned to one libvips thread here: with N workers each using 1 thread
 * we saturate N cores with N images in flight, which beats a few images each
 * fighting over all the threads.
 */

import { parentPort } from 'node:worker_threads';
import sharp from 'sharp';
import { compress, compressAuto } from './pipeline.js';

sharp.concurrency(1);
sharp.cache(false); // batch work streams unique images; a cache just wastes RAM

/** Drop candidate buffers — only the winner's bytes are ever downloaded. */
function stripCandidate(c) {
  const { buffer, ...meta } = c;
  return meta;
}

parentPort.on('message', async (job) => {
  const { id, input, options } = job;
  const buffer = Buffer.from(input); // input arrives as a Uint8Array (copied)
  try {
    let best, candidates;
    if (!options.format || options.format === 'auto') {
      const r = await compressAuto(buffer, options);
      best = r.best;
      candidates = r.candidates.map(stripCandidate);
    } else {
      best = await compress(buffer, options);
      candidates = [stripCandidate(best)];
    }

    // Send the winner's bytes back as a transferable ArrayBuffer (zero-copy).
    const bytes = new Uint8Array(best.buffer);
    const payload = {
      ...stripCandidate(best),
      bytes,
    };
    parentPort.postMessage({ id, ok: true, best: payload, candidates }, [bytes.buffer]);
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err.message });
  }
});
