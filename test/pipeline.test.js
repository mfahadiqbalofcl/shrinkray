/**
 * Self-contained tests — every fixture is generated with sharp, so `npm test`
 * runs anywhere with no sample files. These lock down the properties the whole
 * tool depends on: the metric is monotonic, the size search actually fits the
 * budget, alpha is handled per-format, and the multipart parser is binary-safe.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { compare, prepareReference, compareToReference, visualScore, QUALITY_TARGETS } from '../src/metric.js';
import { compress, compressAuto } from '../src/pipeline.js';
import { getFormat } from '../src/formats.js';
import { parseMultipart } from '../src/multipart.js';

// A detailed synthetic photo: gradients + noise + shapes so codecs have real
// work to do (a flat colour compresses to nothing and hides all differences).
async function makePhoto(width = 900, height = 600) {
  const base = await sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 60, b: 90 } },
  })
    .png()
    .toBuffer();

  const noise = await sharp({
    create: { width, height, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } },
  })
    .png()
    .toBuffer();

  const shapes = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
       <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
         <stop offset="0" stop-color="#ff7a18"/><stop offset="1" stop-color="#3a86ff"/>
       </linearGradient></defs>
       <rect width="100%" height="100%" fill="url(#g)" opacity="0.5"/>
       <circle cx="${width * 0.35}" cy="${height * 0.5}" r="${height * 0.3}" fill="#fff" opacity="0.35"/>
       <text x="40" y="${height - 40}" font-size="90" fill="#0b0b0b" opacity="0.6">Aa Bb 123</text>
     </svg>`
  );

  return sharp(base)
    .composite([{ input: noise, blend: 'overlay' }, { input: shapes }])
    .jpeg({ quality: 98 })
    .toBuffer();
}

async function makeTransparent(width = 400, height = 300) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <circle cx="${width / 2}" cy="${height / 2}" r="${height / 2.5}" fill="#e8470a"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// ---------------------------------------------------------------------------

test('metric: identical images score 0 / 100', async () => {
  const photo = await makePhoto();
  const png = await sharp(photo).png().toBuffer();
  const d = await compare(png, png);
  assert.equal(d, 0);
  assert.equal(visualScore(d), 100);
});

test('metric: DSSIM rises monotonically as quality falls', async () => {
  const photo = await makePhoto();
  const ref = await prepareReference(await sharp(photo).png().toBuffer());

  let prev = -1;
  for (const q of [95, 80, 60, 40, 20]) {
    const buf = await sharp(photo).webp({ quality: q }).toBuffer();
    const d = await compareToReference(ref, buf);
    assert.ok(d > prev, `q=${q}: expected DSSIM ${d} > ${prev}`);
    prev = d;
  }
});

test('metric: visualScore is bounded and decreasing', () => {
  assert.equal(visualScore(0), 100);
  assert.ok(visualScore(0.001) > visualScore(0.01));
  assert.ok(visualScore(0.01) > visualScore(0.1));
  assert.ok(visualScore(5) >= 0);
});

test('size mode: output fits the byte budget', async () => {
  const photo = await makePhoto(1200, 800);
  for (const targetKB of [40, 80, 150]) {
    const r = await compress(photo, { format: 'webp', mode: 'size', targetKB });
    assert.ok(r.size <= targetKB * 1024, `${targetKB}KB target: got ${(r.size / 1024).toFixed(1)}KB`);
    assert.equal(r.targetMet, true);
    // and it should not be absurdly under-budget (search should fill it)
    assert.ok(r.size >= targetKB * 1024 * 0.5, `should use most of the ${targetKB}KB budget`);
  }
});

test('size mode: impossible tiny target is flagged, not faked', async () => {
  const photo = await makePhoto(1600, 1000);
  // 1KB is unreachable for a detailed 1600px photo even after downscaling passes
  const r = await compress(photo, { format: 'jpeg', mode: 'size', targetKB: 1 });
  assert.equal(r.targetMet, false);
});

test('quality mode: meeting the ceiling is honest', async () => {
  const photo = await makePhoto();
  const r = await compress(photo, { format: 'avif', mode: 'quality', target: 'balanced' });
  if (r.targetMet) {
    assert.ok(r.dssim <= QUALITY_TARGETS.balanced + 1e-9, `dssim ${r.dssim} should be <= ceiling`);
  }
  assert.ok(r.size > 0 && r.buffer.length === r.size);
});

test('quality mode: lossless is bit-exact and marked', async () => {
  const photo = await makePhoto(500, 400);
  const r = await compress(photo, { format: 'png', mode: 'quality', target: 'lossless' });
  // decode both and compare raw pixels
  const src = await sharp(photo).raw().toBuffer();
  const out = await sharp(r.buffer).raw().toBuffer();
  assert.deepEqual(out, src, 'lossless PNG must reproduce every pixel');
});

test('alpha: WebP preserves transparency, JPEG flattens', async () => {
  const png = await makeTransparent();
  const w = await compress(png, { format: 'webp', mode: 'quality', target: 'high' });
  const j = await compress(png, { format: 'jpeg', mode: 'quality', target: 'high' });

  const wMeta = await sharp(w.buffer).metadata();
  const jMeta = await sharp(j.buffer).metadata();
  assert.equal(wMeta.channels, 4, 'WebP should keep the alpha channel');
  assert.equal(jMeta.channels, 3, 'JPEG cannot hold alpha and must flatten');
});

test('auto: returns the smallest candidate that met the goal', async () => {
  const photo = await makePhoto();
  const { best, candidates } = await compressAuto(photo, { mode: 'quality', target: 'balanced' });
  assert.ok(candidates.length >= 2);
  const met = candidates.filter((c) => c.targetMet !== false);
  const pool = met.length ? met : candidates;
  const smallest = Math.min(...pool.map((c) => c.size));
  assert.equal(best.size, smallest);
});

test('never silently returns a file larger than source without flagging', async () => {
  // An already-tiny, already-optimised WebP re-compressed losslessly may grow.
  const tiny = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 200, b: 120 } } })
    .webp({ quality: 90 })
    .toBuffer();
  const r = await compress(tiny, { format: 'png', mode: 'quality', target: 'lossless' });
  if (r.size >= tiny.length) assert.equal(r.grewLargerThanSource, true);
});

test('multipart parser is binary-safe and extracts fields + files', async () => {
  const photo = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 200, g: 50, b: 50 } } })
    .png()
    .toBuffer();

  const boundary = '----shrinkrayTEST';
  const CRLF = '\r\n';
  const parts = Buffer.concat([
    Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="mode"${CRLF}${CRLF}size${CRLF}`),
    Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="image"; filename="p.png"${CRLF}Content-Type: image/png${CRLF}${CRLF}`),
    photo,
    Buffer.from(`${CRLF}--${boundary}--${CRLF}`),
  ]);

  const { fields, files } = parseMultipart(parts, `multipart/form-data; boundary=${boundary}`);
  assert.equal(fields.mode, 'size');
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, 'p.png');
  assert.deepEqual(files[0].data, photo, 'file bytes must survive parsing intact');
});

test('formats: registry exposes the expected always-on codecs', async () => {
  for (const id of ['avif', 'webp', 'jpeg', 'png']) {
    const f = getFormat(id);
    assert.equal(await f.available(), true, `${id} should be available`);
    assert.ok(typeof f.encode === 'function');
  }
});
