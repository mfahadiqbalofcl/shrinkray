/**
 * ZIP + batch tests. The ZIP-shape tests are pure and fast; the batch test
 * exercises the real worker pool end-to-end (decode -> parallel compress ->
 * re-zip) and asserts the folder tree survives the round trip.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { zipSync, unzipSync } from 'fflate';

import { isCompressibleImage, readZip, writeZip, rewriteExtension } from '../src/zip.js';
import { compressZip } from '../src/batch.js';
import { getPool } from '../src/pool.js';

after(async () => {
  // Release worker threads so the test process can exit.
  await getPool().destroy();
});

async function photo(w = 500, h = 400, seed = 1) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="100%" height="100%" fill="hsl(${seed * 47 % 360},60%,50%)"/>
    <circle cx="${w / 2}" cy="${h / 2}" r="${h / 3}" fill="hsl(${seed * 91 % 360},70%,60%)"/>
    <text x="20" y="${h - 20}" font-size="60" fill="#000" opacity="0.5">${seed}</text></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toBuffer();
}

test('isCompressibleImage: keeps images, drops junk/dirs/dotfiles', () => {
  assert.equal(isCompressibleImage('a/b/photo.jpg'), true);
  assert.equal(isCompressibleImage('deep/nest/pic.PNG'), true);
  assert.equal(isCompressibleImage('notes.txt'), false);
  assert.equal(isCompressibleImage('folder/'), false);
  assert.equal(isCompressibleImage('__MACOSX/._photo.jpg'), false);
  assert.equal(isCompressibleImage('.hidden/pic.jpg'), false);
});

test('rewriteExtension: keeps folder, swaps ext, avoids collisions', () => {
  assert.equal(rewriteExtension('a/b/photo.png', 'avif'), 'a/b/photo.avif');
  const taken = new Set();
  assert.equal(rewriteExtension('x/p.png', 'avif', taken), 'x/p.avif');
  assert.equal(rewriteExtension('x/p.jpg', 'avif', taken), 'x/p-2.avif'); // collision resolved
});

test('readZip / writeZip round trip preserves paths and skips non-images', async () => {
  const tree = {
    'photos/a.jpg': new Uint8Array(await photo(300, 200, 1)),
    'photos/sub/b.png': new Uint8Array(await sharp(await photo(200, 200, 2)).png().toBuffer()),
    'photos/readme.txt': new Uint8Array(Buffer.from('hi')),
  };
  const { images, skipped } = await readZip(Buffer.from(zipSync(tree)));
  assert.equal(images.length, 2);
  assert.deepEqual(images.map((i) => i.path).sort(), ['photos/a.jpg', 'photos/sub/b.png']);
  assert.ok(skipped.includes('photos/readme.txt'));

  const out = await writeZip(images, { 'manifest.json': '{"ok":true}' });
  const back = unzipSync(new Uint8Array(out));
  assert.ok('photos/a.jpg' in back);
  assert.ok('photos/sub/b.png' in back);
  assert.ok('manifest.json' in back);
});

test('compressZip: compresses every image, preserves the folder tree, adds manifest', async () => {
  const tree = {
    'set/one.jpg': new Uint8Array(await photo(800, 600, 3)),
    'set/two.jpg': new Uint8Array(await photo(600, 800, 4)),
    'set/deep/three.png': new Uint8Array(await sharp(await photo(500, 500, 5)).png().toBuffer()),
    'set/notes.txt': new Uint8Array(Buffer.from('not an image')),
  };
  const { buffer, stats } = await compressZip(Buffer.from(zipSync(tree)), {
    mode: 'quality',
    target: 'balanced',
    format: 'webp',
  });

  assert.equal(stats.images, 3);
  assert.equal(stats.compressed, 3);
  assert.equal(stats.skipped, 1);

  const back = unzipSync(new Uint8Array(buffer));
  // Structure preserved with new extensions, plus the manifest/report.
  assert.ok('set/one.webp' in back);
  assert.ok('set/two.webp' in back);
  assert.ok('set/deep/three.webp' in back, 'nested folder must be preserved');
  assert.ok('manifest.json' in back);
  assert.ok('REPORT.txt' in back);

  // Every output image must decode cleanly.
  for (const [path, data] of Object.entries(back)) {
    if (path.endsWith('.webp')) {
      const meta = await sharp(Buffer.from(data)).metadata();
      assert.equal(meta.format, 'webp');
    }
  }
});
