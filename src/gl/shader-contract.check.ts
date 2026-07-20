import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AUDIO_TRANSITION_TYPES, CSS_TRANSITION_TYPES, GLSL_TRANSITION_TYPES, TRANSITION_LABELS } from '../editor/types';

const files: Record<string, string> = {
  'fx/ascii-rain-blur.frag': '5b95563707c5cf9459fa904b3db9d5db55b19105158a5e73ddca3b3175672cf6',
  'fx/ascii-rain.frag': '2327fe7b5647930aef93e611448f6db77d7a0c59a5ad0e3af3ba327418877acb',
  'fx/ascii-rain-composite.frag': '9a865b51f5e3b239543f9c3aa4a93ad4e89ff72b31347e83f8d7b5c590de8aa1',
  'shaders/dip-to-black.frag': '82b3ba5b2af2e5a26f9f61a98c915c42b759d93434251a14f02ae290f5fd7b93',
  'shaders/cross-dissolve.frag': 'fe1c835fcecf92cbf5ca6b30f25c44c6ef601060e6524f276af928f33cc45ec3',
  'shaders/flash.frag': '9004e06c41c7b9a3f7919f64bf6d3af81eab3f05f640000e2d089ebb1a0f45c5',
  'shaders/luma-blend.frag': '307551fdf1bfd009e2166714cbeffa8063ae5c92cafc5e181aab9ddd1697ca21',
  'shaders/soft-wipe.frag': '63a49620c53e8a857379f09fb40725a3bd6190a120567a8fafc5c7d11b06e00a',
  'shaders/whip-pan.frag': 'a74e981ffa54eb41af8032995efbe4260d1a6f190a6505029b861998ad095eab',
};

for (const [name, expected] of Object.entries(files)) {
  const source = readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8').trim();
  assert.strictEqual(createHash('sha256').update(source).digest('hex'), expected, `${name} content changed`);
}

// Every picture transition must be GLSL. Audio-only transitions carry a label
// but no shader, so exclude them from the visual transition count.
const audio = AUDIO_TRANSITION_TYPES as ReadonlySet<string>;
const visualLabels = Object.keys(TRANSITION_LABELS).filter((t) => !audio.has(t));
assert.strictEqual(GLSL_TRANSITION_TYPES.size, visualLabels.length, 'every non-audio transition must use GLSL');
for (const type of visualLabels) assert.ok(GLSL_TRANSITION_TYPES.has(type), `${type} needs a GLSL shader`);
for (const type of CSS_TRANSITION_TYPES) assert.ok(GLSL_TRANSITION_TYPES.has(type), `${type} needs GLSL plus CSS fallback`);

console.log('shader-contract.check: OK');
