#!/usr/bin/env node
/**
 * Calibration helper for the perceptual thresholds in src/metric.js.
 *
 * The QUALITY_TARGETS DSSIM ceilings ("visually-lossless", "high", …) are
 * judgement calls: a DSSIM number only means something once you've looked at the
 * images that produce it. This script sweeps quality on your own corpus and
 * prints the DSSIM at each step, so you can eyeball a few encodes at a given
 * DSSIM and decide where each threshold belongs for YOUR content.
 *
 *   node tools/calibrate.js <image-or-glob...> [--format webp]
 *
 * It writes encodes to ./calibrate-out/ so you can open them and judge, and
 * prints a table of quality → DSSIM → score → size per image plus the average.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import sharp from 'sharp';
import { prepareReference, compareToReference, visualScore, QUALITY_TARGETS } from '../src/metric.js';
import { getFormat } from '../src/formats.js';

const args = process.argv.slice(2);
const fmtId = (() => {
  const i = args.indexOf('--format');
  return i >= 0 ? args.splice(i, 2)[1] : 'webp';
})();
const files = args.filter((a) => !a.startsWith('-'));

if (!files.length) {
  console.error('Usage: node tools/calibrate.js <image...> [--format webp|avif|jpeg]');
  process.exit(1);
}

const format = getFormat(fmtId);
const QUALITIES = [95, 90, 85, 80, 70, 60, 50, 40, 30, 20];
const OUT = 'calibrate-out';

console.log(`\nCalibrating ${format.label} on ${files.length} image(s). Encodes saved to ./${OUT}/\n`);
console.log('  Reference thresholds:', Object.entries(QUALITY_TARGETS).map(([k, v]) => `${k}=${v}`).join('  '), '\n');

await mkdir(OUT, { recursive: true });

const perQualityDssim = new Map(QUALITIES.map((q) => [q, []]));

for (const file of files) {
  const input = await readFile(file);
  const prepared = await sharp(input).rotate().removeAlpha().png().toBuffer();
  const ref = await prepareReference(prepared);
  const name = basename(file, extname(file));

  console.log(`  ${basename(file)}`);
  console.log(`  ${'q'.padStart(4)}  ${'DSSIM'.padStart(10)}  ${'score'.padStart(6)}  ${'size'.padStart(9)}`);

  for (const q of QUALITIES) {
    const buf = await format.encode(prepared, { quality: q, effort: format.defaultEffort });
    const d = await compareToReference(ref, buf);
    perQualityDssim.get(q).push(d);
    await writeFile(join(OUT, `${name}.q${q}.${format.ext}`), buf);
    console.log(`  ${String(q).padStart(4)}  ${d.toExponential(2).padStart(10)}  ${String(visualScore(d)).padStart(6)}  ${(buf.length / 1024).toFixed(1).padStart(7)}KB`);
  }
  console.log('');
}

console.log('  Average DSSIM across corpus (use this to place thresholds):');
console.log(`  ${'q'.padStart(4)}  ${'avg DSSIM'.padStart(11)}  nearest target`);
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
for (const q of QUALITIES) {
  const avg = mean(perQualityDssim.get(q));
  const nearest = Object.entries(QUALITY_TARGETS)
    .filter(([, v]) => v > 0)
    .reduce((best, cur) => (Math.abs(cur[1] - avg) < Math.abs(best[1] - avg) ? cur : best));
  console.log(`  ${String(q).padStart(4)}  ${avg.toExponential(3).padStart(11)}  ~${nearest[0]}`);
}
console.log('');
