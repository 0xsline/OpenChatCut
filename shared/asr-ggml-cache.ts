// Canonical on-disk location of the whisper.cpp GGML companion models.
//
// Node-only (imported by the Vite server plugin and the desktop native-ASR
// worker); never pull this into browser code — shared/asr-models.ts stays
// fs-free for that reason.
//
// The companions are fetched from the `ggerganov/whisper.cpp` HF repo but are
// stored in a flat `<cache>/ggml/` directory rather than under the repo path,
// because a single GGML file can back several catalog tiers and the desktop
// worker resolves it by file name alone. Downloads used to omit the explicit
// destination and so landed in hf-proxy's default `<cache>/ggerganov/whisper.cpp/`
// layout, which no reader ever looked at: every GGML-bearing tier reported
// "not downloaded" forever and the desktop whisper.cpp engine never engaged.
// `resolveGgmlPath` adopts those stranded files in place so existing installs
// do not re-download hundreds of megabytes.
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** HF repo the GGML companions are downloaded from. */
export const GGML_SOURCE_MODEL_ID = 'ggerganov/whisper.cpp';

/** The only location readers and writers may agree on. */
export function ggmlCachePath(cacheDir: string, fileName: string): string {
  return join(cacheDir, 'ggml', fileName);
}

/** Where pre-fix downloads stranded the file (hf-proxy's default layout). */
export function legacyGgmlCachePath(cacheDir: string, fileName: string): string {
  return join(cacheDir, ...GGML_SOURCE_MODEL_ID.split('/'), fileName);
}

/**
 * Canonical path for `fileName`, adopting a stranded legacy copy first.
 * Never throws: adoption is an optimisation, and a failed rename simply leaves
 * the caller to re-download into the canonical location.
 */
export function resolveGgmlPath(cacheDir: string, fileName: string): string {
  const canonical = ggmlCachePath(cacheDir, fileName);
  if (existsSync(canonical)) return canonical;
  const legacy = legacyGgmlCachePath(cacheDir, fileName);
  if (!existsSync(legacy)) return canonical;
  try {
    mkdirSync(dirname(canonical), { recursive: true });
    renameSync(legacy, canonical);
  } catch {
    // Cross-device or permission failure: the download path recreates it.
  }
  return canonical;
}
