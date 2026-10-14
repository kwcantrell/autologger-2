# media-worker spikes

The throwaway experiments behind the media-worker change (tasks 0.1-0.3; results in
`openspec/changes/media-worker/design.md`, assumptions A10-A13 and the "Spike" notes in D3, D4,
D10, D13 and D17). They are kept so the results can be rerun, not as tests: nothing here runs in CI.
All audio is synthetic.

## Spike 0.1: worker image, blob modes, adoption, network (`volume/`)

Needs Docker with buildx and QEMU for amd64. From the repo root:

```bash
docs/spikes/media-worker/volume/run.sh
```

It builds `docker/media-worker.Dockerfile` for both architectures, uses a throwaway volume and
internal network, and removes them afterwards. `api-init.js` writes blobs the way `BlobStore.put`
does as uid 1000, `worker.js` is a uid 10001 job writing `media/<job>/out.webm` through ffmpeg
(`JOBMODE` sets the job directory's mode), and `api-adopt.js` is the API's adoption sequence
(`O_NOFOLLOW` open, `fstat` checks, copy, `fsync`, `rename`, remove the job directory). Each case
prints what it expects next to the result.

## Spikes 0.2 and 0.3: MediaRecorder slices, storage, locks (`browser/`)

`www/record.html` (0.2) records with a 5 s timeslice and, in parallel, without one, then reports
MIME types, MP4 atom order, decoded durations and the files. `www/storage.html` (0.3) checks OPFS
`createSyncAccessHandle` in a worker, IndexedDB `Blob` storage, `navigator.locks` across two tabs,
`navigator.wakeLock` and `navigator.storage`. Both work by hand in any browser over `localhost`.

Automated (headless Chromium, Firefox, WebKit via Playwright 1.64.0). Work on a copy, so the run's
`node_modules` and outputs stay out of the repo:

```bash
cp -r docs/spikes/media-worker/browser /tmp/mw-spike && cd /tmp/mw-spike
npm i --no-save playwright@1.64.0 && npx playwright install chromium firefox webkit
python3 tone.py && mkdir -p out
node server.mjs 8765 &
node drive.mjs chromium http://localhost:8765
node drive.mjs firefox http://localhost:8765
MIME=audio/mp4 node drive.mjs chromium http://localhost:8765
PERSISTENT=1 node drive.mjs webkit http://localhost:8765   # WebKit on Linux: storage only, no MediaRecorder
```

Results land in `out/<browser>-result.json`, the recordings in `out/`. Decode them with the
worker's pinned ffmpeg (the digest in `docker/media-worker.Dockerfile`), for example
`docker run --rm -i --network none <image> -nostdin -hide_banner -loglevel error -xerror
-protocol_whitelist pipe -f matroska -i pipe:0 -map 0:a:0 -f f32le pipe:1 < out/chromium-concat.webm | wc -c`.
`gum.mjs <url>` reports whether WebKit exposes `MediaRecorder` and the microphone.

### Safari (task A.11)

Safari records finished chunks only (`SAFARI_PERSIST_MODE = 'finished-only'`) because no Safari was
available for spike 0.2. To check whether it can switch to `slices`: serve `browser/www/` over
`localhost` or HTTPS (for example `node server.mjs 8765` and a tunnel), open `record.html` in
Safari, click Start, keep sound going for 25 s, and keep the downloaded files and `result.json`.
`slices` is safe when `concat` and `whole` decode to the same codec, rate and sample count and the
atoms show `moov` before `mdat`. Then run `storage.html` in two tabs as the page describes.
