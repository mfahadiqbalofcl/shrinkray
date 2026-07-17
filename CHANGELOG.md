# Changelog

Notable changes to ShrinkRay. The format loosely follows
[Keep a Changelog](https://keepachangelog.com/). Versions are milestones, not
npm releases.

## [1.3.0] - Resumable uploads and reliable downloads

Makes the upload and download robust enough to trust with big files.

### Added

- Chunked, resumable uploads. A ZIP is uploaded as 8 MB chunks, up to four in flight at once, and a dropped chunk is retried on its own instead of restarting the whole upload. Progress reflects real bytes stored on the server.
- The download now starts automatically the moment the ZIP is ready, with the Download button kept as a fallback in case the browser blocks the automatic one.
- HTTP Range support on downloads, so the browser shows real download progress and can resume an interrupted download.

### Fixed

- After compressing, the Download button could do nothing if the result was no longer available. The server now returns `410 Gone` for an expired result and the UI says "This download expired. Please compress again." instead of failing silently.

### Changed

- New endpoints for the upload flow: `POST /api/upload/init`, `PUT /api/upload/chunk/:id`, `GET /api/upload/status/:id`, `POST /api/upload/process/:id`. The old raw-body `POST /api/compress-zip` stays as a fallback.

## [1.2.0] - Large uploads and staged progress

Handles archives from a few hundred MB up to several GB, and shows what's
happening at each step.

### Added

- Streaming, memory-bounded ZIP processing. The upload streams to a temp file, the archive is read one image at a time (yauzl), each image is compressed on the worker pool, and the result is streamed into the output ZIP on disk (yazl). Peak RAM is bounded by `workers × one decoded image`, not by the archive size, so a 400 MB ZIP and a 4 GB ZIP use about the same memory.
- A real upload-progress bar. The client uses `XHR` instead of `fetch` (which can't report upload progress), so a 400 MB upload no longer looks frozen.
- A staged status panel: Uploading, Reading, Compressing (with a live count, running size saved, and an ETA), Packaging, Ready.
- `SHRINKRAY_WORKERS=N` to set the pool size for your machine's RAM and cores.

### Changed

- The quality search now stops climbing near the top of the quality range once a target is clearly out of reach. This removes the WebP-to-q100 balloon on already-compressed sources.
- Auto mode skips formats that can't beat the current best size.
- The default pool size leaves some headroom: `max(2, min(cores - 2, 8))`.

### Fixed

- Uploading a large ZIP (for example 431 MB) failed. The whole upload was buffered in memory and unzipped at once, which ran the process out of RAM.

## [1.1.0] - ZIP in/out and parallel batches

### Added

- ZIP in, ZIP out, with the folder structure preserved, plus a `manifest.json` and a `REPORT.txt`. Originals are kept when a re-encode would make them larger.
- A worker-thread pool, so batches use every core instead of one.
- Download all as ZIP for a batch of loose images.

### Changed

- Batches are about 4× faster (119 s to 28 s for 8 photos, auto + balanced), from encoding out of raw pixels, sharing one decoded source and metric reference across formats, seeding the search with an early exit, and dropping AVIF effort from 4 to 3.

## [1.0.0] - Initial release

### Added

- Local-first image compressor with two modes: keep visual quality (smallest file under a perceptual DSSIM ceiling) or target a size (fill a KB budget).
- Formats: AVIF, WebP, JPEG, PNG, and optional JPEG XL (via `cjxl`).
- A web UI with drag-and-drop and a before/after slider, a CLI, and a library API.
- A hand-written multi-scale DSSIM metric in CIELAB, and a `calibrate` tool to re-tune the thresholds for your own images.
