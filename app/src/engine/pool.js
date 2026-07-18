/**
 * A small pool of compression workers. It keeps one worker per core busy, so a
 * batch of images compresses in parallel and the UI thread stays smooth. The API
 * is a promise per job; `run` / `runAuto` resolve with the worker's result.
 */

const SIZE = Math.max(2, Math.min((navigator.hardwareConcurrency || 4), 8));

export class Pool {
  constructor(size = SIZE) {
    this.size = size;
    this._workers = [];
    this._idle = [];
    this._queue = [];
    this._jobs = new Map();
    this._nextId = 1;
    for (let i = 0; i < size; i++) this._spawn();
  }

  _spawn() {
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => this._onMessage(worker, e.data);
    worker.onerror = (e) => this._onError(worker, e);
    this._workers.push(worker);
    this._idle.push(worker);
  }

  _onMessage(worker, msg) {
    const job = this._jobs.get(msg.id);
    if (job) {
      this._jobs.delete(msg.id);
      msg.ok ? job.resolve(msg.result) : job.reject(new Error(msg.error));
    }
    this._idle.push(worker);
    this._pump();
  }

  _onError(worker, e) {
    for (const [id, job] of this._jobs) {
      if (job.worker === worker) { this._jobs.delete(id); job.reject(new Error(e.message || 'Worker crashed')); }
    }
    this._workers = this._workers.filter((w) => w !== worker);
    this._idle = this._idle.filter((w) => w !== worker);
    worker.terminate();
    this._spawn();
    this._pump();
  }

  _pump() {
    while (this._idle.length && this._queue.length) {
      const worker = this._idle.shift();
      const task = this._queue.shift();
      const id = this._nextId++;
      this._jobs.set(id, { resolve: task.resolve, reject: task.reject, worker });
      worker.postMessage({ id, op: task.op, input: task.input, inputType: task.inputType, opts: task.opts }, [task.input]);
    }
  }

  _submit(op, input, inputType, opts) {
    return new Promise((resolve, reject) => {
      this._queue.push({ op, input, inputType, opts, resolve, reject });
      this._pump();
    });
  }

  /** Compress one image with one format. `input` is an ArrayBuffer (transferred). */
  run(input, inputType, opts) { return this._submit('single', input, inputType, opts); }

  /** Compress trying several formats; resolves { best, candidates }. */
  runAuto(input, inputType, opts) { return this._submit('auto', input, inputType, opts); }

  /** Encode once at an explicit quality (live precision tuning). */
  probe(input, inputType, opts) { return this._submit('probe', input, inputType, opts); }

  /**
   * Preload a codec so the first real compress isn't stalled on a network fetch.
   * One worker compiles the WASM, which also primes the browser's HTTP cache, so
   * any other worker that later needs the same codec fetches it from cache. We
   * deliberately warm only ONE worker, not all of them: firing a warm on every
   * worker at once triggers a herd of concurrent cold WASM compiles that saturate
   * the CPU and actually slow down the very first compression.
   */
  warm(format) { return this._submit('warm', new ArrayBuffer(0), '', { format }).catch(() => {}); }

  destroy() { this._workers.forEach((w) => w.terminate()); this._workers = []; this._idle = []; }
}

let shared = null;
export function getPool() { return (shared ||= new Pool()); }
