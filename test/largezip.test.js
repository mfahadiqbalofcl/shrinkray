/**
 * Streaming large-ZIP path: file on disk -> file on disk, entry by entry.
 * Verifies the folder tree survives, non-images are skipped, and staged
 * progress events fire in order — without ever holding the archive in memory.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { zipSync, unzipSync } from 'fflate';
import { processZipFile } from '../src/largezip.js';
import { getPool } from '../src/pool.js';

after(async () => { await getPool().destroy(); });

async function photo(w, h, seed) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="hsl(${seed * 53 % 360},55%,50%)"/><circle cx="${w / 2}" cy="${h / 2}" r="${h / 3}" fill="#fff" opacity="0.4"/></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

test('processZipFile: streams a ZIP file, preserves folders, reports stages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shrinkray-test-'));
  try {
    const tree = {
      'album/a.jpg': new Uint8Array(await photo(600, 400, 1)),
      'album/b.jpg': new Uint8Array(await photo(500, 500, 2)),
      'album/nested/deep/c.png': new Uint8Array(await sharp(await photo(400, 400, 3)).png().toBuffer()),
      'album/readme.txt': new Uint8Array(Buffer.from('skip me')),
    };
    const inPath = join(dir, 'in.zip');
    const outPath = join(dir, 'out.zip');
    await writeFile(inPath, Buffer.from(zipSync(tree)));

    const stagesSeen = [];
    let lastDone = 0;
    const { stats } = await processZipFile(inPath, outPath, { mode: 'size', targetKB: 40, format: 'webp' }, (ev) => {
      if (ev.stage && !stagesSeen.includes(ev.stage)) stagesSeen.push(ev.stage);
      if (ev.stage === 'compressing') { assert.ok(ev.done >= lastDone); lastDone = ev.done; }
    });

    // Stages fire in the right order.
    assert.deepEqual(stagesSeen, ['reading', 'start', 'compressing', 'packaging', 'done']);
    assert.equal(stats.images, 3);
    assert.equal(stats.compressed, 3);
    assert.equal(stats.skipped, 1);

    // Output structure preserved, images decode, manifest present.
    const back = unzipSync(new Uint8Array(await readFile(outPath)));
    assert.ok('album/a.webp' in back);
    assert.ok('album/b.webp' in back);
    assert.ok('album/nested/deep/c.webp' in back, 'nested folder preserved');
    assert.ok('manifest.json' in back);
    assert.ok('REPORT.txt' in back);
    for (const [p, d] of Object.entries(back)) {
      if (p.endsWith('.webp')) assert.equal((await sharp(Buffer.from(d)).metadata()).format, 'webp');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('processZipFile: survives absolute-path / root "/" entries (real-world ZIPs)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shrinkray-test-'));
  try {
    // These names mirror what Finder/Windows/exporters really produce and what
    // made a 347MB client ZIP hang on "reading": a bare "/" root entry, an
    // absolute path, and a traversal. yauzl would abort the whole archive on any
    // of them; the fix decodes + sanitizes names so the read just carries on.
    const tree = {
      '/': new Uint8Array(0),                                  // bare root dir entry
      '/House/photo1.jpg': new Uint8Array(await photo(700, 500, 1)), // absolute path
      'Kitchen/photo2.jpg': new Uint8Array(await photo(600, 600, 2)),
      '../escape.jpg': new Uint8Array(await photo(500, 400, 3)),      // zip-slip attempt
      'notes.txt': new Uint8Array(Buffer.from('skip me')),
    };
    const inPath = join(dir, 'in.zip');
    const outPath = join(dir, 'out.zip');
    await writeFile(inPath, Buffer.from(zipSync(tree)));

    const { stats } = await processZipFile(inPath, outPath, { mode: 'quality', target: 'balanced', format: 'webp' }, () => {});
    assert.equal(stats.images, 3, 'all three images found despite the odd names');
    assert.equal(stats.compressed, 3);

    const back = unzipSync(new Uint8Array(await readFile(outPath)));
    const names = Object.keys(back);
    // Every output name is a safe relative path — no leading slash, no traversal.
    for (const n of names) {
      assert.ok(!n.startsWith('/'), `no absolute path in output: ${n}`);
      assert.ok(!n.split('/').includes('..'), `no traversal in output: ${n}`);
    }
    assert.ok('House/photo1.webp' in back, 'absolute path was relativised');
    assert.ok('Kitchen/photo2.webp' in back);
    assert.ok('escape.webp' in back, 'traversal stripped to a safe name');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('processZipFile: directory entries are not miscounted as skipped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shrinkray-test-'));
  try {
    // Explicit directory entries (keys ending in "/") plus one real non-image.
    // Only the non-image should count as skipped — not the folders.
    const tree = {
      'album/': new Uint8Array(0),
      'album/sub/': new Uint8Array(0),
      'album/a.jpg': new Uint8Array(await photo(500, 400, 1)),
      'album/notes.txt': new Uint8Array(Buffer.from('skip me')),
    };
    const inPath = join(dir, 'in.zip');
    const outPath = join(dir, 'out.zip');
    await writeFile(inPath, Buffer.from(zipSync(tree)));

    const { stats } = await processZipFile(inPath, outPath, { mode: 'quality', target: 'high', format: 'webp' }, () => {});
    assert.equal(stats.images, 1);
    assert.equal(stats.skipped, 1, 'only notes.txt is skipped; the two folders are not');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
