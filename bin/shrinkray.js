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

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { basename, extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { compress, compressAuto, availableFormats, QUALITY_TARGETS } from '../src/pipeline.js';

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

  if (opts.out) await mkdir(resolve(opts.out), { recursive: true });

  const goal = opts.mode === 'size' ? `≤ ${kb(targetBytes)}` : `${opts.target} fidelity`;
  console.log(c.dim(`\nShrinkRay · ${goal} · format ${opts.format} · ${opts.files.length} file(s)\n`));

  // Bound parallelism to cores; each AVIF encode is already multi-threaded, so
  // we don't oversubscribe wildly — half the cores keeps the box responsive.
  const limit = Math.max(1, Math.floor(os.cpus().length / 2));
  const queue = [...opts.files];
  let totalIn = 0, totalOut = 0, ok = 0, failed = 0;

  async function worker() {
    while (queue.length) {
      const file = queue.shift();
      try {
        const line = await processOne(file, opts, shared);
        totalIn += line.originalSize;
        totalOut += line.size;
        ok++;
        console.log(line.text);
      } catch (err) {
        failed++;
        console.log(`  ${c.red('✗')} ${basename(file)} — ${err.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));

  if (ok > 1) {
    const saved = totalIn > 0 ? Math.round((1 - totalOut / totalIn) * 100) : 0;
    console.log(c.dim('  ' + '─'.repeat(40)));
    console.log(`  ${c.bold('Total')}  ${kb(totalIn)} → ${c.bold(kb(totalOut))}  ${c.green(saved + '% smaller')}  (${ok} ok${failed ? `, ${failed} failed` : ''})`);
  }
  console.log('');
  if (failed) process.exitCode = 1;
}

async function processOne(file, opts, shared) {
  const input = await readFile(file);

  let result;
  if (opts.format === 'auto') {
    const { best } = await compressAuto(input, shared);
    result = best;
  } else {
    result = await compress(input, { ...shared, format: opts.format });
  }

  const outPath = destPath(file, result.ext, opts);
  await writeFile(outPath, result.buffer);

  const pct = Math.round((1 - result.ratio) * 100);
  const pctStr = pct >= 0 ? c.green(`${pct}% smaller`) : c.yellow(`${-pct}% larger`);
  const flags = [];
  if (result.grewLargerThanSource) flags.push(c.yellow('⚠ larger than source — keep original'));
  if (result.targetMet === false) flags.push(c.yellow('⚠ target not reached'));

  const text =
    `  ${c.green('✓')} ${c.bold(basename(file))} ${c.dim('→')} ${basename(outPath)}  ` +
    `${kb(result.originalSize)} → ${c.bold(kb(result.size))}  ${pctStr}  ` +
    c.dim(`[${result.label} ${result.note}, score ${result.score}]`) +
    (flags.length ? '\n      ' + flags.join('  ') : '');

  return { text, size: result.size, originalSize: result.originalSize };
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
  shrinkray <files...> [options]
  shrinkray serve [port]

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
