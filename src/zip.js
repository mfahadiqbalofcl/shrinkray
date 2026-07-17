/**
 * ZIP in, ZIP out — with the folder structure preserved.
 *
 * Drop in `photos.zip` (nested folders and all) and get back `photos.zip` with
 * every image compressed and sitting at the same path, just with a new
 * extension. Uses fflate, which is the fast, streaming, tiny choice for this.
 *
 * Two deliberate decisions:
 *  - Output images are STORED (not re-deflated) in the result ZIP. AVIF/WebP/
 *    JPEG are already entropy-coded; deflating them again wastes CPU for ~0%
 *    gain. Storing keeps the re-zip near-instant.
 *  - Non-image entries and junk (__MACOSX, dotfiles, directories) are skipped on
 *    the way in, and a machine-readable manifest.json is added on the way out.
 */

import { unzip, zip, strToU8 } from 'fflate';
import { basename, extname } from 'node:path';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.tiff', '.tif', '.heic', '.heif', '.bmp']);

/** Is this zip entry an image we should try to compress? */
export function isCompressibleImage(path) {
  if (path.endsWith('/')) return false; // directory entry
  if (path.startsWith('__MACOSX/')) return false; // macOS resource-fork junk
  // Reject anything under, or being, a dotfile/dot-directory (.git, .DS_Store,
  // ._resourceforks, .hidden/…). Any path segment starting with '.' is out.
  if (path.split('/').some((seg) => seg.startsWith('.'))) return false;
  return IMAGE_EXT.has(extname(basename(path)).toLowerCase());
}

/**
 * Read a ZIP buffer into image entries, preserving their paths.
 * @param {Buffer|Uint8Array} buffer
 * @returns {Promise<{images: {path:string,data:Buffer}[], skipped: string[]}>}
 */
export function readZip(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return new Promise((resolve, reject) => {
    unzip(u8, (err, files) => {
      if (err) return reject(new Error(`Could not read ZIP: ${err.message}`));
      const images = [];
      const skipped = [];
      for (const [path, data] of Object.entries(files)) {
        if (data.length === 0 && path.endsWith('/')) continue; // pure directory
        if (isCompressibleImage(path)) images.push({ path, data: Buffer.from(data) });
        else if (!path.endsWith('/') && !path.startsWith('__MACOSX/')) skipped.push(path);
      }
      resolve({ images, skipped });
    });
  });
}

/**
 * Build a ZIP from entries, storing (not deflating) already-compressed bytes.
 * @param {{path:string,data:Buffer|Uint8Array}[]} entries
 * @param {object} [extras] additional text files to embed, e.g. { 'manifest.json': '...' }
 * @returns {Promise<Buffer>}
 */
export function writeZip(entries, extras = {}) {
  const tree = {};
  for (const { path, data } of entries) {
    // level 0 = store; images won't deflate further, so don't waste the CPU.
    tree[path] = [data instanceof Uint8Array ? data : new Uint8Array(data), { level: 0 }];
  }
  for (const [name, text] of Object.entries(extras)) {
    tree[name] = [strToU8(text), { level: 6 }]; // text does compress — deflate it
  }
  return new Promise((resolve, reject) => {
    zip(tree, {}, (err, out) => {
      if (err) return reject(new Error(`Could not write ZIP: ${err.message}`));
      resolve(Buffer.from(out));
    });
  });
}

/**
 * Swap a path's extension while keeping its folder. `a/b/photo.png` + 'avif'
 * -> `a/b/photo.avif`. Guards against collisions when several source formats
 * map to the same output name in the same folder.
 */
export function rewriteExtension(path, ext, taken) {
  const dir = path.slice(0, path.length - basename(path).length);
  const stem = basename(path, extname(path));
  let candidate = `${dir}${stem}.${ext}`;
  if (taken) {
    let n = 2;
    while (taken.has(candidate)) candidate = `${dir}${stem}-${n++}.${ext}`;
    taken.add(candidate);
  }
  return candidate;
}
