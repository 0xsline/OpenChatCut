// Runnable check: `npx tsx src/agent/sceneQuality.verify.ts`.
import assert from 'node:assert/strict';
import { reviewScenePlan } from './sceneQuality';
import type { SceneLike } from './sceneQuality';
import { SCENE_QUALITY_TOOL_SCHEMAS } from './tools/schemas/scene-quality-tools';

const repeated: SceneLike[] = Array.from({ length: 9 }, (_, index) => ({
  type: index % 3 === 0 ? ' video ' : index % 3 === 1 ? 'Video' : 'VIDEO',
  description: '  MODERN cinematic visual  ',
  shotIntent: '   ',
  informationRole: '\t',
}));
const repeatedReport = reviewScenePlan(repeated);
assert.equal(repeatedReport.advisory, true);
assert.equal(repeatedReport.verdict, 'revise');
assert.ok(repeatedReport.score >= 3, 'repeated, generic, purposeless plan should receive material advisory risk');
assert.ok(
  repeatedReport.findings.some((finding) => finding.dimension === 'repetition' && finding.scenes.length === 9),
  'trimmed/lowercased type repetition should cover the full run',
);
assert.ok(
  repeatedReport.findings.some((finding) => finding.dimension === 'generic_language' && finding.scenes.length === 9),
  'generic phrases should be matched case-insensitively',
);
assert.ok(
  repeatedReport.findings.some((finding) => finding.dimension === 'decorative_visuals' && finding.scenes.length === 9),
  'whitespace-only responsibilities should count as missing',
);

const denseGeneric = Array.from({ length: 4 }, (_, index): SceneLike => ({
  type: index % 2 ? 'image' : 'video',
  description: `Modern concrete shot ${index}`,
  shotIntent: `beat ${index}`,
}));
const sparseGeneric = Array.from({ length: 40 }, (_, index): SceneLike => ({
  type: index % 2 ? 'image' : 'video',
  description: index < 4 ? `Modern concrete shot ${index}` : `Concrete subject ${index}`,
  shotIntent: `beat ${index}`,
}));
assert.ok(
  reviewScenePlan(denseGeneric).score > reviewScenePlan(sparseGeneric).score,
  'the same number/severity of affected scenes must be normalized by total scene count',
);

const schemaNames = SCENE_QUALITY_TOOL_SCHEMAS.map((schema) => schema.name);
assert.deepEqual(schemaNames, ['review_scene_plan'], 'only the advisory tool name is exposed');
assert.doesNotMatch(SCENE_QUALITY_TOOL_SCHEMAS[0]!.description ?? '', /\bgate\b/i);

console.log('sceneQuality.verify: advisory naming, normalization, whitespace, case, and repetition ok');
