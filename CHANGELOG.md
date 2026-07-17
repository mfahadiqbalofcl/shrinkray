# Changelog

All notable changes to ShrinkRay. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions are milestones, not
npm releases.

## [1.2.0] — Large uploads & staged progress

Handles archives from hundreds of MB up to several GB, with a clear picture of
what's happening at every step.

### Added

- **Streaming, memory-bounded ZIP processing.** Uploads stream straight to a
  temp file; the archive is read one image at a time (yauzl), compressed on the
  worker pool, and streamed into the output ZIP on disk (yazl). Peak RAM is
  bounded by `workers × one decoded image`, not the archive size — a 400 MB ZIP
  and a 4 GB ZIP use about the same memory.
- **Real upload-progress bar.** The client uses `XHR` (not `fetch`, which can't
  report upload progress) so a 400 MB upload no longer looks frozen.
- **Staged status UI:** Uploading → Reading → Compressing (live count, running
  size saved, ETA) → Packaging → Ready.
- `SHRINKRAY_WORKERS=N` to tune the pool size for your machine's RAM/cores.

### Changed

- Quality search stops climbing near max quality on unreachable fidelity
  targets — kills the WebP-to-q100 balloon on already-compressed sources.
- Auto mode prunes formats that can't beat the current best size.
- Default pool size leaves headroom (`max(2, min(cores − 2, 8))`).

### Fixed

- Uploading a large ZIP (e.g. 431 MB) failed — the whole upload was buffered in
  memory and unzipped at once, which exhausted RAM.

## [1.1.0] — ZIP in/out & parallel

### Added

- **ZIP in → ZIP out** with the folder structure preserved, plus a
  `manifest.json` and `REPORT.txt`. Originals are kept when a re-encode would
  grow them.
- **Worker-thread pool** — batches use every core instead of one.
- "Download all as ZIP" for a batch of loose images.

### Changed

- ~4× faster batches (119 s → 28 s for 8 photos, auto + balanced) via encoding
  from raw pixels, a shared decoded source + metric reference across formats,
  seeded search with early-exit, and AVIF effort 4 → 3.

## [1.0.0] — Initial release

### Added

- Local-first image compressor: **keep visual quality** (smallest file under a
  perceptual DSSIM ceiling) or **target a size** (fill a KB budget).
- Formats: AVIF, WebP, JPEG, PNG, and optional JPEG XL (via `cjxl`).
- Web UI with drag-and-drop and a before/after slider, a CLI, and a library API.
- A hand-written multi-scale DSSIM metric in CIELAB, and a `calibrate` tool to
  re-tune the thresholds for your own images.
