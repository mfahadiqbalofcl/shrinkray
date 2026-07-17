# ShrinkRay 🗜️

**A local-first image compressor you run yourself. Unlimited, free, private, open source.**

Drop in a JPEG/PNG/WebP/AVIF/TIFF/GIF and get back the smallest possible AVIF, WebP, JPEG, PNG (or JXL) — either **kept visually identical** or **squeezed to fit an exact KB budget**. Nothing is uploaded; every byte is processed on your machine by [sharp](https://sharp.pixelplumbing.com/) (libvips). No accounts, no limits, no "upgrade to Pro."

It solves the two problems that make online compressors annoying:

1. **"Compress without losing quality."** ShrinkRay doesn't guess a quality number. It measures the *perceptual* difference between the original and each candidate encode ([DSSIM](#how-it-works), the metric behind JPEG XL/Guetzli) and finds the **smallest file that stays under a visible-difference threshold**. You pick the threshold in plain words ("visually lossless", "balanced"), not a magic 0–100 dial.

2. **"Make it exactly N kilobytes."** Tell it `--size 100kb` and it binary-searches the quality to *fill* that budget at the best possible quality, then downscales only if the target genuinely can't be met — and tells you honestly when it can't.

![ShrinkRay UI](docs/screenshot.png)

---

## Quick start

Requires **Node 18+**. From the project folder:

```bash
npm install          # installs sharp (the only dependency)
npm start            # launches the web UI at http://127.0.0.1:4747
```

Open the URL, drag images in, download. That's it.

Prefer the terminal? The CLI is the same engine:

```bash
# Keep it visually identical, let it pick the best format
node bin/shrinkray.js hero.jpg --target visually-lossless

# Fit under 100 KB
node bin/shrinkray.js hero.jpg --size 100kb

# Batch a whole folder to WebP under 80 KB each, into out/
node bin/shrinkray.js images/*.png --size 80kb --format webp -o out/

# Launch the web UI
node bin/shrinkray.js serve
```

Install it globally so `shrinkray` works from anywhere:

```bash
npm link             # then: shrinkray photo.jpg --target balanced
```

---

## The two modes

### Keep quality → smallest file

Choose a fidelity target; ShrinkRay returns the smallest file whose perceptual
difference (DSSIM) stays under that budget:

| Target | Meaning | Typical DSSIM ceiling |
|---|---|---|
| `lossless` | Bit-exact. No pixels change. | 0 |
| `visually-lossless` | You can't tell, even zoomed in. | 0.001 |
| `high` | Differences only under pixel-peeping. | 0.003 |
| `balanced` | Excellent for web. | 0.008 |
| `small` | Noticeable up close, fine in a page. | 0.02 |
| `tiny` | Thumbnails / previews. | 0.05 |

### Target a size → best quality that fits

Give a byte budget (`80kb`, `1.5mb`). ShrinkRay binary-searches quality to fill
it, and only downscales (in geometric steps) if even minimum quality overshoots.
If your target is physically unreachable, the result is flagged
`target not reached` instead of silently pretending.

Both modes work with **Auto** format (try them all, keep the smallest) or a
specific format.

---

## How it works

The interesting part is *"without losing quality."* Most tools just let you pick
a quality number and hope. ShrinkRay closes the loop:

1. **Decode the original** into planar CIELAB — a perceptually-uniform colour
   space where "distance" tracks what the eye notices, weighting lightness far
   above chroma (which is exactly what codecs throw away first).
2. **Encode a candidate** at some quality.
3. **Score it** with a multi-scale, DSSIM-style SSIM in CIELAB — the same family
   of metric that guides JPEG XL and Guetzli. It catches both fine ringing and
   coarse blotching, and unlike PSNR it correlates with human judgement.
4. **Binary-search** the quality knob. Encoding is monotonic — higher quality
   means a bigger file *and* a lower DSSIM — so ~7 probes converge on the
   optimum. To stay fast, the search encodes at a cheap "effort", then does a
   single final encode of the winner at full effort (higher effort only shrinks
   the file, so the perceptual guarantee still holds).

The DSSIM thresholds are honest judgement calls, calibrated on a mixed
photo/illustration/screenshot corpus. Re-tune them for your own content:

```bash
node tools/calibrate.js my-images/*.jpg --format avif
```

---

## Use it as a library

```js
import { compress, compressAuto } from 'shrinkray';
import { readFile, writeFile } from 'node:fs/promises';

const input = await readFile('hero.jpg');

// Smallest visually-identical file, best format chosen automatically
const { best } = await compressAuto(input, { mode: 'quality', target: 'visually-lossless' });
await writeFile(`hero.${best.ext}`, best.buffer);
console.log(best.label, best.size, `${Math.round((1 - best.ratio) * 100)}% smaller`);

// Or a hard size budget, specific format
const r = await compress(input, { format: 'avif', mode: 'size', targetKB: 120 });
```

Every result carries real measured numbers: `size`, `dssim`, a 0–100 `score`,
`ratio`, `width`/`height`, `targetMet`, and `grewLargerThanSource`.

---

## Formats

| Format | Notes |
|---|---|
| **AVIF** | Best compression; slowest to encode. Built into sharp. |
| **WebP** | Great balance of size, speed, and support. |
| **JPEG** | Uses mozjpeg (trellis quant) for the final pass. No alpha — flattened. |
| **PNG** | Lossless, or palette-quantised below quality 100. |
| **JPEG XL** | Optional — enabled automatically if the `cjxl` binary is on your PATH (`brew install jpeg-xl`). sharp's prebuilt libvips ships without it. |

---

## Design principles

- **Local-first.** No network calls. The server binds to `127.0.0.1` and streams
  results from memory — nothing is written to disk or sent anywhere.
- **Near-zero dependencies.** Just `sharp`. The HTTP server, multipart parser,
  metric, and UI are hand-written and auditable.
- **Honest output.** It never hands back a larger file, a missed target, or a
  guessed quality without saying so.

---

## License

[MIT](LICENSE). Do whatever you want with it.
