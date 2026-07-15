# Bundled FFmpeg

The published ChatCut plugin snapshot includes compressed `ffmpeg` and
`ffprobe` executables in this directory. They are injected by
`.github/workflows/sync-chatcut-codex.yml`; binary artifacts are intentionally
not stored in the ChatCut monorepo.

Current targets:

- `darwin-arm64`: FFmpeg 8.1 builds from https://www.osxexperts.net/
- `win32-x64`: FFmpeg 8.1.2 Essentials from https://www.gyan.dev/ffmpeg/builds/

The publishing workflow verifies the provider archive and executable SHA-256
checksums before adding deterministic gzip files to the standalone plugin
repository. `upload-media.mjs` verifies the decompressed executable checksum
again before use. Explicit command-line paths and environment overrides take
precedence; unsupported platforms and unavailable bundles fall back to
`ffmpeg` and `ffprobe` on `PATH`.

FFmpeg is free software. See https://ffmpeg.org/legal.html and the provider
license/readme files included in the published snapshot.
