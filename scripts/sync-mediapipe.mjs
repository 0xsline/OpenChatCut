// Sync MediaPipe vision runtime into public/mediapipe/ (same-origin, offline-safe).
// - WASM: copied from node_modules/@mediapipe/tasks-vision/wasm
// - Models: downloaded from Google's mediapipe-models storage (float16 variants)
// Run after upgrading @mediapipe/tasks-vision or to refresh the models:
//   node scripts/sync-mediapipe.mjs
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WASM_SRC = join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const PUBLIC_DIR = join(ROOT, 'public', 'mediapipe');
const WASM_DIR = join(PUBLIC_DIR, 'wasm');

const MODELS = [
  {
    file: 'selfie_segmenter.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
  },
  {
    file: 'blaze_face_short_range.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite',
  },
];

if (!existsSync(WASM_SRC)) {
  console.error(`@mediapipe/tasks-vision not installed (looked at ${WASM_SRC})`);
  process.exit(1);
}

await mkdir(WASM_DIR, { recursive: true });

for (const file of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm']) {
  await copyFile(join(WASM_SRC, file), join(WASM_DIR, file));
  console.log(`wasm: ${file}`);
}

for (const model of MODELS) {
  const target = join(PUBLIC_DIR, model.file);
  if (existsSync(target)) {
    console.log(`model: ${model.file} (already present, skipping download)`);
    continue;
  }
  console.log(`model: downloading ${model.file} …`);
  const res = await fetch(model.url);
  if (!res.ok) {
    console.error(`  failed (HTTP ${res.status}); place the file manually at ${target}`);
    continue;
  }
  await writeFile(target, new Uint8Array(await res.arrayBuffer()));
  console.log(`model: ${model.file} (${(target.length / 1024).toFixed(0)} KB)`);
}

console.log('mediapipe sync complete.');
