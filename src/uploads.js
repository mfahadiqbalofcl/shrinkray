/**
 * Resumable chunked uploads.
 *
 * A big file is uploaded as many small chunks instead of one giant request.
 * That means a dropped connection loses one chunk, not the whole upload; the
 * client can retry or resume; progress is accurate; and several chunks can be
 * in flight at once. Each session pre-allocates its file on disk and writes
 * each chunk at its byte offset, so chunks can arrive in any order or be
 * retried without corrupting the result (writing the same offset twice is a
 * no-op for our accounting).
 *
 * This is the same idea behind S3 multipart uploads and the tus protocol, kept
 * small and local.
 */

import { mkdtemp, rm, open, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // abandon an idle upload after 2h
const sessions = new Map();

function touch(session) {
  clearTimeout(session.timer);
  session.timer = setTimeout(() => discardUpload(session.id), SESSION_TTL_MS);
  session.timer.unref?.();
}

/**
 * Start an upload. Pre-allocates the destination file to `size` so positioned
 * chunk writes always land, even out of order.
 */
export async function createUpload({ filename = 'upload.bin', size }) {
  if (!Number.isFinite(size) || size <= 0) {
    throw Object.assign(new Error('A positive file size is required'), { status: 400 });
  }
  const dir = await mkdtemp(join(tmpdir(), 'shrinkray-up-'));
  const path = join(dir, 'in.zip');
  const fh = await open(path, 'w');
  try { await fh.truncate(size); } finally { await fh.close(); }

  const id = randomUUID();
  const session = { id, dir, path, size, filename, received: 0, offsets: new Set(), timer: null };
  touch(session);
  sessions.set(id, session);
  return { id, size };
}

/** Write one chunk at `offset`. Idempotent: re-sending a chunk doesn't double-count. */
export async function writeChunk(id, offset, buffer) {
  const s = sessions.get(id);
  if (!s) throw Object.assign(new Error('Upload session not found (it may have expired)'), { status: 404 });
  if (!Number.isFinite(offset) || offset < 0 || offset + buffer.length > s.size) {
    throw Object.assign(new Error('Chunk is out of range for this upload'), { status: 400 });
  }
  touch(s);
  if (s.offsets.has(offset)) return { received: s.received, size: s.size }; // already have it

  const fh = await open(s.path, 'r+');
  try {
    await fh.write(buffer, 0, buffer.length, offset);
  } finally {
    await fh.close();
  }
  s.offsets.add(offset);
  s.received += buffer.length;
  return { received: s.received, size: s.size };
}

/** How many bytes we've received (for resume). */
export function uploadStatus(id) {
  const s = sessions.get(id);
  if (!s) return null;
  return { received: s.received, size: s.size, complete: s.received >= s.size };
}

/**
 * Mark an upload complete and hand back its session so the caller can process
 * the assembled file. Verifies every byte actually arrived (not just that the
 * pre-allocated file is the right length).
 */
export async function finalizeUpload(id) {
  const s = sessions.get(id);
  if (!s) throw Object.assign(new Error('Upload session not found (it may have expired)'), { status: 404 });
  if (s.received !== s.size) {
    throw Object.assign(new Error(`Upload incomplete: ${s.received} of ${s.size} bytes received`), { status: 409 });
  }
  const st = await stat(s.path).catch(() => null);
  if (!st || st.size !== s.size) {
    throw Object.assign(new Error('Assembled file is the wrong size'), { status: 500 });
  }
  clearTimeout(s.timer);
  sessions.delete(id); // the caller now owns s.dir / s.path and cleans it up
  return s;
}

export async function discardUpload(id) {
  const s = sessions.get(id);
  if (!s) return;
  clearTimeout(s.timer);
  sessions.delete(id);
  await rm(s.dir, { recursive: true, force: true }).catch(() => {});
}
