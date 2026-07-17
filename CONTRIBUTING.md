# Contributing

Thanks for taking a look. ShrinkRay is small on purpose: a couple of native dependencies, and otherwise hand-written code you can read end to end. Contributions that keep it that way are very welcome.

## Getting set up

```bash
git clone https://github.com/mfahadiqbalofcl/shrinkray.git
cd shrinkray
npm install
npm test        # 17 tests, all self-contained (no sample files needed)
npm start       # web UI at http://127.0.0.1:4747
```

You need Node 18 or newer. JPEG XL support is optional and turns on by itself if `cjxl` is on your PATH (`brew install jpeg-xl`).

## How the code is laid out

| File | What it does |
| --- | --- |
| `src/metric.js` | The perceptual metric: multi-scale DSSIM in CIELAB. |
| `src/formats.js` | Codec registry (quality and effort scales, availability). |
| `src/search.js` | The two searches: quality-target and size-budget. |
| `src/pipeline.js` | Public API: `compress` and `compressAuto`. |
| `src/pool.js` / `src/worker.js` | Worker-thread pool for parallel batches. |
| `src/zip.js` / `src/batch.js` | In-memory ZIP path (small archives). |
| `src/largezip.js` | Streaming, disk-backed ZIP path (large archives). |
| `src/server.js` | HTTP server and upload streaming, no framework. |
| `public/` | The web UI (plain HTML/CSS/ES modules, no build step). |
| `bin/shrinkray.js` | The CLI. |

## Ground rules

- Keep dependencies minimal. A new runtime dependency needs a good reason. The server, metric, upload handling, and UI are deliberately dependency-free.
- Keep the output honest. The tool never returns a larger file, a missed target, or a guessed quality without flagging it. Please keep that property.
- Add a test for behaviour changes. Tests are self-contained, so generate fixtures with sharp rather than committing binaries.
- Match the surrounding style. No formatter is enforced. Read the file you're editing and follow it.

## If you change the metric

The DSSIM thresholds in `QUALITY_TARGETS` are calibrated judgement calls. If you change the metric's resolution or its scales, re-run the calibrator and update the thresholds:

```bash
node tools/calibrate.js path/to/your/images/*.jpg --format avif
```

## Reporting bugs

Open an issue with the image (or a description of it), the settings you used, and what you expected versus what happened. A failing case added as a test is the most useful thing you can bring.
