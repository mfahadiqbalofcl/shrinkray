/**
 * Format registry.
 *
 * Each format exposes a single `encode(sharpInput, { quality, effort, ... })`
 * that returns a Buffer, plus the metadata the search and UI need: the quality
 * scale to search, whether it supports alpha, whether it can be lossless, and
 * whether it's actually available on this machine (JXL rides on an optional
 * `cjxl` binary, since sharp's prebuilt libvips omits it).
 *
 * The point of the abstraction: the binary search in search.js only ever asks
 * "encode at quality Q" and "is this format available" — it never branches on
 * format. Adding a codec means adding an entry here, nothing else.
 */

import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile, unlink, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * Build a sharp instance from either an encoded Buffer or a raw-pixel descriptor
 * `{ data, width, height, channels }`. The raw path is what the search uses on
 * every iteration — it skips re-decoding a PNG each time, which is one of the
 * biggest per-encode savings.
 */
function fromSource(source) {
  if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
    return sharp(source, { failOn: 'none' });
  }
  return sharp(source.data, {
    failOn: 'none',
    raw: { width: source.width, height: source.height, channels: source.channels },
  });
}

// ---------------------------------------------------------------------------
// Optional CLI encoder detection (cached for the process lifetime)
// ---------------------------------------------------------------------------

const binaryCache = new Map();

async function hasBinary(name) {
  if (binaryCache.has(name)) return binaryCache.get(name);
  let ok = false;
  try {
    await execFileAsync(name, ['--version'], { timeout: 4000 });
    ok = true;
  } catch (err) {
    // Some encoders exit non-zero on --version but still exist; treat
    // "command not found" (ENOENT) as absent and anything else as present.
    ok = err.code !== 'ENOENT' && err.code !== 127;
  }
  binaryCache.set(name, ok);
  return ok;
}

/** Run a CLI encoder through temp files. Cleans up even on failure. */
async function encodeViaCli(bin, buildArgs, inputBuffer, outExt) {
  const dir = await mkdtemp(join(tmpdir(), 'shrinkray-'));
  const inPath = join(dir, `in`);
  const outPath = join(dir, `out.${outExt}`);
  try {
    await writeFile(inPath, inputBuffer);
    await execFileAsync(bin, buildArgs(inPath, outPath), { timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
    return await readFile(outPath);
  } finally {
    await Promise.allSettled([unlink(inPath), unlink(outPath)]);
  }
}

// ---------------------------------------------------------------------------
// Format definitions
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} FormatDef
 * @property {string} id
 * @property {string} label
 * @property {string} ext          file extension
 * @property {string} mime
 * @property {boolean} alpha        preserves transparency
 * @property {boolean} canLossless
 * @property {[number,number]} qualityRange  inclusive search bounds
 * @property {number} defaultEffort
 * @property {[number,number]} effortRange
 * @property {() => Promise<boolean>} available
 * @property {(input, opts) => Promise<Buffer>} encode
 */

/** @type {Record<string, FormatDef>} */
export const FORMATS = {
  avif: {
    id: 'avif',
    label: 'AVIF',
    ext: 'avif',
    mime: 'image/avif',
    alpha: true,
    canLossless: true,
    qualityRange: [1, 100],
    // libaom speed 0-9 (higher = slower/smaller). 3 is the value that matters:
    // measured, effort 4 is 3x slower than 3 for only ~3% smaller files, and
    // effort 5 barely moves the needle. 3 is the production sweet spot.
    defaultEffort: 3,
    searchEffort: 2, // faster still per probe; final encode uses defaultEffort
    effortRange: [0, 9],
    available: async () => true, // built into sharp/libvips
    async encode(input, { quality, effort = 4, lossless = false, chromaSubsampling }) {
      return fromSource(input)
        .avif({
          quality,
          effort,
          lossless,
          chromaSubsampling: chromaSubsampling ?? (quality >= 90 ? '4:4:4' : '4:2:0'),
        })
        .toBuffer();
    },
  },

  webp: {
    id: 'webp',
    label: 'WebP',
    ext: 'webp',
    mime: 'image/webp',
    alpha: true,
    canLossless: true,
    qualityRange: [1, 100],
    defaultEffort: 4,
    searchEffort: 2,
    effortRange: [0, 6],
    available: async () => true,
    async encode(input, { quality, effort = 4, lossless = false }) {
      return fromSource(input)
        .webp({ quality, effort, lossless, smartSubsample: true })
        .toBuffer();
    },
  },

  jpeg: {
    id: 'jpeg',
    label: 'JPEG',
    ext: 'jpg',
    mime: 'image/jpeg',
    alpha: false, // JPEG has no alpha — pipeline flattens onto a background first
    canLossless: false,
    qualityRange: [1, 100],
    defaultEffort: 1, // mozjpeg trellis on/off; expressed as effort 0|1
    searchEffort: 0, // plain libjpeg during search is fast; final pass uses mozjpeg
    effortRange: [0, 1],
    available: async () => true,
    async encode(input, { quality, effort = 1 }) {
      return fromSource(input)
        .jpeg({
          quality,
          mozjpeg: effort >= 1, // trellis quant + optimised Huffman: smaller, slower
          chromaSubsampling: quality >= 90 ? '4:4:4' : '4:2:0',
        })
        .toBuffer();
    },
  },

  png: {
    id: 'png',
    label: 'PNG',
    ext: 'png',
    mime: 'image/png',
    alpha: true,
    canLossless: true,
    // PNG "quality" drives palette quantisation (lossy). 100 = full-colour lossless.
    qualityRange: [1, 100],
    defaultEffort: 7,
    searchEffort: 3,
    effortRange: [1, 10],
    available: async () => true,
    async encode(input, { quality, effort = 7, lossless = false }) {
      // quality 100 (or lossless) => true lossless deflate; below => palette-quantised.
      const palette = !lossless && quality < 100;
      return fromSource(input)
        .png({
          compressionLevel: 9,
          effort,
          palette,
          quality: palette ? quality : undefined,
          dither: palette ? 1 : undefined,
        })
        .toBuffer();
    },
  },

  jxl: {
    id: 'jxl',
    label: 'JPEG XL',
    ext: 'jxl',
    mime: 'image/jxl',
    alpha: true,
    canLossless: true,
    qualityRange: [1, 100],
    defaultEffort: 7, // cjxl -e (1..9)
    searchEffort: 4,
    effortRange: [1, 9],
    available: () => hasBinary('cjxl'),
    async encode(input, { quality, effort = 7, lossless = false }) {
      // sharp/libvips prebuilt binaries ship without libjxl, so we shell out to
      // the reference `cjxl`. Feed it a PNG so it never has to guess the input.
      const png = await fromSource(input).png().toBuffer();
      return encodeViaCli(
        'cjxl',
        (inPath, outPath) => {
          const args = [inPath, outPath, '-e', String(effort)];
          if (lossless) args.push('-d', '0');
          else args.push('-q', String(quality));
          return args;
        },
        png,
        'jxl'
      );
    },
  },
};

/** Formats actually usable right now, in a sensible display order. */
export async function availableFormats() {
  const order = ['avif', 'webp', 'jpeg', 'png', 'jxl'];
  const out = [];
  for (const id of order) {
    const def = FORMATS[id];
    if (await def.available()) {
      out.push({
        id: def.id,
        label: def.label,
        ext: def.ext,
        mime: def.mime,
        alpha: def.alpha,
        canLossless: def.canLossless,
        qualityRange: def.qualityRange,
        effortRange: def.effortRange,
        defaultEffort: def.defaultEffort,
      });
    }
  }
  return out;
}

export function getFormat(id) {
  const def = FORMATS[id];
  if (!def) throw new Error(`Unknown format: ${id}`);
  return def;
}
