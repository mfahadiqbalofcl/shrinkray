#!/usr/bin/env node
/**
 * ShrinkRay CLI.
 *
 *   shrinkray photo.jpg                       # keep quality (high), auto format, write next to source
 *   shrinkray *.png --target visually-lossless --format avif
 *   shrinkray hero.jpg --size 100kb           # fit under 100 KB
 *   shrinkray img/*.jpg -o out/ --format webp # batch into a folder
 *   shrinkray serve                           # launch the web UI
 *
 * Batch runs in parallel up to the CPU count. Every line it prints is a real
 * measured number — size, percent saved, and the perceptual score — so a script
 * or a human can trust the output without re-checking.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableFormats, QUALITY_TARGETS } from '../src/pipeline.js';
import { getPool } from '../src/pool.js';
import { compressZip } from '../src/batch.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// tiny ANSI helpers (no dependency)
// ---------------------------------------------------------------------------
const tty = process.stdout.isTTY;
const c = {
  dim: (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s),
  cyan: (s) => (tty ? `\x1b[36m${s}\x1b[0m` : s),
  yellow: (s) => (tty ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s),
};

const kb = (n) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1024 / 1024).toFixed(2)}MB`);

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    mode: 'quality',
    target: 'high',
    format: 'auto',
    out: null,
    effort: undefined,
    maxEdge: undefined,
    suffix: '',
    files: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-o': case '--out': opts.out = next(); break;
      case '-f': case '--format': opts.format = next(); break;
      case '-t': case '--target': opts.target = next(); opts.mode = 'quality'; break;
      case '-s': case '--size': opts.mode = 'size'; opts.size = next(); break;
      case '-e': case '--effort': opts.effort = Number(next()); break;
      case '--max-edge': opts.maxEdge = Number(next()); break;
      case '--suffix': opts.suffix = next(); break;
      case '-h': case '--help': opts.help = true; break;
      case '-v': case '--version': opts.version = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`Unknown option: ${a}`);
        opts.files.push(a);
    }
  }
  return opts;
}

/** Parse "100kb", "1.5mb", "80000" -> bytes. */
function parseSize(str) {
  const m = /^([\d.]+)\s*(kb|mb|k|m|b)?$/i.exec(String(str).trim());
  if (!m) throw new Error(`Bad size: "${str}" (try 100kb, 1.5mb)`);
  const n = parseFloat(m[1]);
  const unit = (m[2] || 'kb').toLowerCase();
  const mult = unit.startsWith('m') ? 1024 * 1024 : unit === 'b' ? 1 : 1024;
  return Math.round(n * mult);
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function runServe(rest) {
  // Delegate to the server module; pass through PORT if given.
  const portArg = rest.find((a) => /^\d+$/.test(a));
  if (portArg) process.env.PORT = portArg;
  await import('../src/server.js');
}

async function runCompress(opts) {
  if (!opts.files.length) { printHelp(); process.exit(1); }

  const targetBytes = opts.mode === 'size' ? parseSize(opts.size) : undefined;
  const shared = {
    mode: opts.mode,
    target: opts.target,
    targetKB: targetBytes ? targetBytes / 1024 : undefined,
    effort: opts.effort,
    maxEdge: opts.maxEdge || undefined,
  };

  if (opts.mode === 'quality' && !(opts.target in QUALITY_TARGETS)) {
    throw new Error(`Unknown target "${opts.target}". Options: ${Object.keys(QUALITY_TARGETS).join(', ')}`);
  }

  const compressOpts = {
    mode: opts.mode,
    format: opts.format,
    target: opts.target,
    targetKB: targetBytes ? targetBytes / 1024 : undefined,
    effort: opts.effort,
    maxEdge: opts.maxEdge || undefined,
  };

  // A single .zip input -> a .zip output with the folder structure preserved.
  const zipInput = opts.files.length === 1 && /\.zip$/i.test(opts.files[0]);
  if (zipInput) return runZipCli(opts.files[0], compressOpts, opts);

  if (opts.out) await mkdir(resolve(opts.out), { recursive: true });

  const goal = opts.mode === 'size' ? `≤ ${kb(targetBytes)}` : `${opts.target} fidelity`;
  const pool = getPool();
  console.log(c.dim(`\nShrinkRay · ${goal} · format ${opts.format} · ${opts.files.length} file(s) · ${pool.size} workers\n`));

  // Read all inputs, then compress them in parallel across the worker pool.
  const jobs = [];
  for (const file of opts.files) {
    try {
      jobs.push({ input: await readFile(file), options: compressOpts, meta: { file } });
    } catch (err) {
      console.log(`  ${c.red('✗')} ${basename(file)} — ${err.message}`);
    }
  }

  let totalIn = 0, totalOut = 0, ok = 0, failed = 0;
  const results = await pool.map(jobs, () => {});
  for (const r of results) {
    const file = r.meta.file;
    if (!r.ok || !r.best) {
      failed++;
      console.log(`  ${c.red('✗')} ${basename(file)} — ${r.error}`);
      continue;
    }
    const best = r.best;
    const outPath = destPath(file, best.ext, opts);
    await writeFile(outPath, Buffer.from(best.bytes));
    totalIn += best.originalSize;
    totalOut += best.size;
    ok++;

    const pct = Math.round((1 - best.ratio) * 100);
    const pctStr = pct >= 0 ? c.green(`${pct}% smaller`) : c.yellow(`${-pct}% larger`);
    const flags = [];
    if (best.grewLargerThanSource) flags.push(c.yellow('⚠ larger than source — keep original'));
    if (best.targetMet === false) flags.push(c.yellow('⚠ target not reached'));
    console.log(
      `  ${c.green('✓')} ${c.bold(basename(file))} ${c.dim('→')} ${basename(outPath)}  ` +
        `${kb(best.originalSize)} → ${c.bold(kb(best.size))}  ${pctStr}  ` +
        c.dim(`[${best.label} ${best.note}, score ${best.score}]`) +
        (flags.length ? '\n      ' + flags.join('  ') : '')
    );
  }

  if (ok > 1) {
    const saved = totalIn > 0 ? Math.round((1 - totalOut / totalIn) * 100) : 0;
    console.log(c.dim('  ' + '─'.repeat(40)));
    console.log(`  ${c.bold('Total')}  ${kb(totalIn)} → ${c.bold(kb(totalOut))}  ${c.green(saved + '% smaller')}  (${ok} ok${failed ? `, ${failed} failed` : ''})`);
  }
  console.log('');
  await pool.destroy();
  if (failed) process.exitCode = 1;
}

/** Compress every image inside a ZIP, writing a new ZIP that mirrors its tree. */
async function runZipCli(zipPath, compressOpts, opts) {
  const input = await readFile(zipPath);
  const outPath = opts.out
    ? (extname(opts.out) === '.zip' ? resolve(opts.out) : join(resolve(opts.out), basename(zipPath, extname(zipPath)) + '-compressed.zip'))
    : join(dirname(resolve(zipPath)), basename(zipPath, extname(zipPath)) + '-compressed.zip');
  if (opts.out && extname(opts.out) !== '.zip') await mkdir(resolve(opts.out), { recursive: true });

  const goal = compressOpts.mode === 'size' ? `≤ ${compressOpts.targetKB}KB` : `${compressOpts.target} fidelity`;
  console.log(c.dim(`\nShrinkRay · ZIP · ${goal} · format ${compressOpts.format}\n`));

  let lastDone = 0;
  const { buffer, stats } = await compressZip(input, compressOpts, (ev) => {
    if (ev.done !== lastDone) {
      lastDone = ev.done;
      process.stdout.write(`\r  compressing ${ev.done}/${ev.total}   `);
    }
  });
  await writeFile(outPath, buffer);
  await getPool().destroy();

  console.log(`\r  ${c.green('✓')} ${stats.compressed} images` + (stats.skipped ? c.dim(` (${stats.skipped} non-image skipped)`) : '') + '        ');
  console.log(`  ${kb(stats.totalIn)} → ${c.bold(kb(stats.totalOut))}  ${c.green(stats.percentSaved + '% smaller')}`);
  console.log(`  ${c.dim('→')} ${outPath}\n`);
}

function destPath(file, ext, opts) {
  const base = basename(file, extname(file)) + opts.suffix;
  const dir = opts.out ? resolve(opts.out) : dirname(resolve(file));
  return join(dir, `${base}.${ext}`);
}

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

async function printHelp() {
  const formats = (await availableFormats()).map((f) => f.id).join(', ');
  console.log(`
${c.bold('ShrinkRay')} — local image compressor (AVIF · WebP · JPEG · PNG${formats.includes('jxl') ? ' · JXL' : ''})

${c.bold('Usage')}
  shrinkray <files...> [options]      one or many images (compressed in parallel)
  shrinkray photos.zip [options]      a ZIP in -> a ZIP out, folder tree preserved
  shrinkray serve [port]              launch the drag-and-drop web UI

${c.bold('Modes')}
  ${c.cyan('--target <name>')}   keep visual quality; pick the smallest file within it
                   ${c.dim(Object.keys(QUALITY_TARGETS).join(', '))}
  ${c.cyan('--size <n>')}        fit under a byte budget   e.g. --size 100kb, --size 1.5mb

${c.bold('Options')}
  ${c.cyan('-f, --format')}      avif | webp | jpeg | png${formats.includes('jxl') ? ' | jxl' : ''} | auto   (default: auto)
  ${c.cyan('-o, --out <dir>')}   write outputs to a folder (default: beside each source)
  ${c.cyan('-e, --effort <n>')}  encoder effort; higher = smaller & slower
  ${c.cyan('--max-edge <px>')}   cap the longest side before encoding
  ${c.cyan('--suffix <s>')}      append to output filename (e.g. --suffix .min)
  ${c.cyan('-h, --help')}        this help

${c.bold('Examples')}
  ${c.dim('# Shrink one photo, keep it visually identical, let it pick the best format')}
  shrinkray hero.jpg --target visually-lossless

  ${c.dim('# Batch a folder of PNGs to WebP under 80KB each, into out/')}
  shrinkray images/*.png --size 80kb --format webp -o out/

  ${c.dim('# Launch the drag-and-drop web UI')}
  shrinkray serve
`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'serve') return runServe(argv.slice(1));

  const opts = parseArgs(argv);
  if (opts.version) {
    const pkg = JSON.parse(await readFile(join(__dirname, '..', 'package.json'), 'utf8'));
    console.log(pkg.version);
    return;
  }
  if (opts.help || argv.length === 0) return printHelp();
  await runCompress(opts);
}

main().catch((err) => {
  console.error(c.red(`\nError: ${err.message}\n`));
  process.exit(1);
});
