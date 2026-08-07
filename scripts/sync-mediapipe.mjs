// Provision the pinned MediaPipe runtime under public/mediapipe/.
// WASM comes from the lockfile-pinned npm package; model bytes are verified
// before installation so fresh checkouts and offline reruns are deterministic.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WASM_SRC = join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const PUBLIC_DIR = join(ROOT, 'public', 'mediapipe');
const WASM_DIR = join(PUBLIC_DIR, 'wasm');
const WASM_FILES = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
];
const MODELS = [
  {
    file: 'selfie_segmenter.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite',
    bytes: 249_537,
    sha256: '191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b',
  },
  {
    file: 'blaze_face_short_range.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
    bytes: 229_746,
    sha256: 'b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f',
  },
];

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function hasVerifiedModel(target, model) {
  try {
    const bytes = await readFile(target);
    return bytes.length === model.bytes && digest(bytes) === model.sha256;
  } catch {
    return false;
  }
}

async function syncModel(model) {
  const target = join(PUBLIC_DIR, model.file);
  if (await hasVerifiedModel(target, model)) {
    process.stdout.write(`model: ${model.file} (verified)\n`);
    return;
  }
  const response = await fetch(model.url);
  if (!response.ok) throw new Error(`failed to download ${model.file} (HTTP ${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== model.bytes || digest(bytes) !== model.sha256) {
    throw new Error(`integrity mismatch for ${model.file}`);
  }
  const temporary = `${target}.download-${process.pid}`;
  await writeFile(temporary, bytes);
  await rm(target, { force: true });
  await rename(temporary, target);
  process.stdout.write(`model: ${model.file} (${(bytes.length / 1024).toFixed(0)} KB, verified)\n`);
}

if (!existsSync(WASM_SRC)) {
  throw new Error(`@mediapipe/tasks-vision not installed (looked at ${WASM_SRC})`);
}
await mkdir(WASM_DIR, { recursive: true });
for (const file of WASM_FILES) {
  await copyFile(join(WASM_SRC, file), join(WASM_DIR, file));
  process.stdout.write(`wasm: ${file}\n`);
}
for (const model of MODELS) await syncModel(model);
process.stdout.write('mediapipe sync complete.\n');
