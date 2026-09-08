// onnxruntime-web must resolve to a build that carries the MatMulNBits DQ-fusion fix.
//
// ONNX Runtime 1.25 introduced a regression in the DQ->MatMulNBits fusion: when two
// DequantizeLinear nodes share a weight or scale initializer — which is exactly what
// Whisper's tied decoder embeddings produce — the first fusion consumes the initializer
// and the second dies with "Missing required scale". Every q8 Whisper tier fails to load
// on wasm, on every OS. Fixed by microsoft/onnxruntime#28326, merged 2026-05-12 and first
// released in 1.27.0 (2026-06-19).
//
// @huggingface/transformers 4.2.0 pins onnxruntime-web at an exact 1.26.0-dev build from
// 2026-04-16, four weeks before that fix, so the version here is held in place by an
// `overrides` entry in package.json. That is a fragile arrangement: a transformers release
// that changes its pin, or a careless lockfile regeneration, silently drops us back onto a
// broken build. The failure is runtime-only — type-check, lint and build all stay green
// while local transcription is completely dead (issue #120).
//
// So it is asserted here instead.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Read package.json off disk rather than require()-ing it: onnxruntime-web's `exports`
// map does not expose ./package.json, so the module resolver refuses the subpath.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readVersion = (moduleDir: string): string | null => {
  const manifest = join(root, 'node_modules', moduleDir, 'package.json');
  if (!existsSync(manifest)) return null;
  return (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version;
};

/** First release containing microsoft/onnxruntime#28326. */
const MINIMUM = { major: 1, minor: 27 } as const;

const parse = (version: string) => {
  const [core] = version.split('-');
  const [major, minor, patch] = (core ?? '').split('.').map(Number);
  assert.ok(
    Number.isInteger(major) && Number.isInteger(minor) && Number.isInteger(patch),
    `unparseable onnxruntime-web version: ${version}`,
  );
  return { major: major!, minor: minor!, patch: patch! };
};

const resolvedVersion = readVersion('onnxruntime-web');
assert.ok(resolvedVersion, 'onnxruntime-web is not installed');
const resolved = { version: resolvedVersion! };
const { major, minor } = parse(resolved.version);

assert.ok(
  major > MINIMUM.major || (major === MINIMUM.major && minor >= MINIMUM.minor),
  `onnxruntime-web resolved to ${resolved.version}, which predates the MatMulNBits fix `
  + `(first released in ${MINIMUM.major}.${MINIMUM.minor}.0). Every q8 Whisper tier will fail `
  + 'to create a wasm session with "TransposeDQWeightsForMatMulNBits Missing required scale". '
  + 'Restore the onnxruntime-web override in package.json.',
);

// A pre-release of the minimum version is not the minimum version: 1.27.0-dev builds were
// cut before the fix landed, so a dev tag on the boundary release is rejected outright.
if (major === MINIMUM.major && minor === MINIMUM.minor) {
  assert.ok(
    !resolved.version.includes('-dev'),
    `onnxruntime-web ${resolved.version} is a pre-release of the boundary version; `
    + 'those builds predate the fix. Pin a released 1.27.0 or newer.',
  );
}

// transformers.js reaches ort through its own dependency, so a nested copy would quietly
// win over the hoisted one and make the assertion above meaningless.
const nested = readVersion('@huggingface/transformers/node_modules/onnxruntime-web');
assert.equal(
  nested,
  null,
  `@huggingface/transformers has its own onnxruntime-web (${nested}), which is what its `
  + 'wasm sessions will actually load. The override in package.json is not taking effect.',
);

console.log(`onnxruntime-web version check passed (${resolved.version}, no nested copy)`);
