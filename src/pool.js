/**
 * A tiny fixed-size worker pool for CPU-bound compression jobs.
 *
 * Node's event loop is single-threaded, and our perceptual metric is heavy JS —
 * so without this, ten images compress one after another on one core. The pool
 * keeps one worker per core busy, turning a batch into an N-way parallel run.
 *
 * The API is deliberately small: `run()` for a single job, `map()` for a batch
 * with progress. Workers are reused across calls; `destroy()` tears them down.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, 'worker.js');

export function defaultPoolSize() {
  // Leave two logical cores for the main thread + OS, and cap at 8. Heavy image
  // encoding is bound by PHYSICAL cores, so more workers past that mostly add
  // memory (each holds its own sharp + a full raw-decoded image) without speed.
  const cores = os.cpus().length;
  const env = Number(process.env.SHRINKRAY_WORKERS);
  if (env > 0) return Math.min(env, 32);
  return Math.max(2, Math.min(cores - 2, 8));
}

// A single job should never take this long. It's a backstop against a worker
// that wedges (a pathological encode/metric) or exits silently — without it, that
// job's promise never settles and the whole batch hangs forever behind a
// still-ticking progress heartbeat. Generous, so a genuinely huge image never
// trips it; override with SHRINKRAY_JOB_TIMEOUT_MS.
const JOB_TIMEOUT_MS = Number(process.env.SHRINKRAY_JOB_TIMEOUT_MS) || 10 * 60 * 1000;

export class Pool {
  constructor(size = defaultPoolSize()) {
    this.size = size;
    this._workers = [];
    this._idle = [];
    this._queue = [];
    this._jobs = new Map(); // id -> { resolve, reject, worker, timer }
    this._nextId = 1;
    this._destroyed = false;
    for (let i = 0; i < size; i++) this._spawn();
  }

  _spawn() {
    const worker = new Worker(WORKER_PATH);
    worker.on('message', (msg) => this._onMessage(worker, msg));
    worker.on('error', (err) => this._replaceWorker(worker, err));
    // A worker can also die WITHOUT an 'error' (a clean but unexpected exit, OOM
    // kill). Catch that too, or its in-flight job would never settle.
    worker.on('exit', () => { if (!this._destroyed) this._replaceWorker(worker, new Error('Worker exited unexpectedly')); });
    this._workers.push(worker);
    this._idle.push(worker);
  }

  _onMessage(worker, msg) {
    const job = this._jobs.get(msg.id);
    if (job) {
      clearTimeout(job.timer);
      this._jobs.delete(msg.id);
      if (msg.ok) job.resolve(msg);
      else job.reject(new Error(msg.error));
    }
    this._idle.push(worker);
    this._pump();
  }

  // A worker that crashes hard (native fault, OOM), errors, or times out rejects
  // its in-flight job and is replaced, so one bad image can't wedge the pool.
  // Idempotent: 'error' and 'exit' can both fire for the same death.
  _replaceWorker(worker, err) {
    if (!this._workers.includes(worker)) return;
    for (const [id, job] of this._jobs) {
      if (job.worker === worker) {
        clearTimeout(job.timer);
        this._jobs.delete(id);
        job.reject(err);
      }
    }
    this._workers = this._workers.filter((w) => w !== worker);
    this._idle = this._idle.filter((w) => w !== worker);
    worker.terminate().catch(() => {});
    if (!this._destroyed) this._spawn();
    this._pump();
  }

  _onJobTimeout(id) {
    const job = this._jobs.get(id);
    if (!job) return;
    this._jobs.delete(id);
    job.reject(new Error('Compression timed out — this image took too long or the worker became unresponsive'));
    this._replaceWorker(job.worker, new Error('Worker timed out')); // wedged worker: replace its slot
  }

  _pump() {
    while (this._idle.length && this._queue.length) {
      const worker = this._idle.shift();
      const task = this._queue.shift();
      const id = this._nextId++;
      const timer = setTimeout(() => this._onJobTimeout(id), JOB_TIMEOUT_MS);
      timer.unref?.(); // don't keep the process alive just for the backstop
      this._jobs.set(id, { resolve: task.resolve, reject: task.reject, worker, timer });
      // Copy the input into a standalone Uint8Array so transferring it can never
      // detach memory shared by Node's Buffer pool.
      const bytes = Uint8Array.prototype.slice.call(task.input);
      worker.postMessage({ id, input: bytes, options: task.options }, [bytes.buffer]);
    }
  }

  /** Compress one image. Resolves to { best, candidates } (best carries bytes). */
  run(input, options) {
    if (this._destroyed) return Promise.reject(new Error('Pool destroyed'));
    return new Promise((resolve, reject) => {
      this._queue.push({ input, options, resolve, reject });
      this._pump();
    });
  }

  /**
   * Compress many. `jobs` is an array of { input, options, ...meta }; the meta is
   * echoed back on each result so callers can keep names/paths. `onProgress` is
   * called as each finishes with { index, done, total, meta, result?, error? }.
   */
  async map(jobs, onProgress) {
    const total = jobs.length;
    let done = 0;
    const results = await Promise.all(
      jobs.map(async (job, index) => {
        try {
          const res = await this.run(job.input, job.options);
          done++;
          onProgress?.({ index, done, total, meta: job.meta, result: res });
          return { ok: true, meta: job.meta, ...res };
        } catch (err) {
          done++;
          onProgress?.({ index, done, total, meta: job.meta, error: err.message });
          return { ok: false, meta: job.meta, error: err.message };
        }
      })
    );
    return results;
  }

  async destroy() {
    this._destroyed = true;
    for (const job of this._jobs.values()) clearTimeout(job.timer);
    await Promise.all(this._workers.map((w) => w.terminate()));
    this._workers = [];
    this._idle = [];
  }
}

// Lazily-created shared pool for the server/CLI so workers are spun up once.
let shared = null;
export function getPool() {
  if (!shared) shared = new Pool();
  return shared;
}
