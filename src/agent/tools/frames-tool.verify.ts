// Runnable check: `npx tsx src/agent/tools/frames-tool.verify.ts`.
import assert from 'node:assert/strict';
import { sourceWindowForTimelineRange } from '../../editor/sourceLimit';
import { constrainSourceFrameArgs, explicitSourceTimesMs } from './frames-tool';
import { FRAMES_TOOL_SCHEMAS } from './schemas/frames-tool';

const window = sourceWindowForTimelineRange(
  { srcInFrame: 10, playbackRate: 2 },
  0,
  15,
);
assert.deepEqual(window, { startFrame: 10, endFrame: 40 });
assert.deepEqual(
  constrainSourceFrameArgs({ frames: [0, 20, 99] }, window, 30).frames,
  [10, 20, 39],
  'source-frame requests are clamped to the speed/trim-aware visible window',
);
assert.deepEqual(
  constrainSourceFrameArgs({ seconds: [0, 1, 2] }, window, 30).seconds,
  [10 / 30, 1, 39 / 30],
  'source seconds stay source coordinates rather than timeline-local coordinates',
);
const ranged = constrainSourceFrameArgs({}, window, 30);
assert.equal(ranged.fromSeconds, 10 / 30);
assert.equal(ranged.toSeconds, 40 / 30);
assert.deepEqual(
  explicitSourceTimesMs({ seconds: [0, 1, 2, 3, 4, 5, 6, 7, 8, Number.NaN] }, 30),
  [0, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000],
  'every renderer enforces the eight-frame context budget for explicit coordinates',
);

const timelineSchema = FRAMES_TOOL_SCHEMAS.find((schema) => schema.name === 'view_timeline_frames')!;
const assetSchema = FRAMES_TOOL_SCHEMAS.find((schema) => schema.name === 'view_asset_frames')!;
assert.match(timelineSchema.description ?? '', /ABSOLUTE TIMELINE/);
assert.match(assetSchema.description ?? '', /SOURCE-MEDIA/);
assert.ok('itemId' in (assetSchema.input_schema.properties ?? {}));
const sourceTimesSchema = assetSchema.input_schema.properties?.sourceTimesMs as { maxItems?: number };
assert.equal(sourceTimesSchema.maxItems, 8);

console.log('frames-tool.verify: explicit coordinate spaces and visible source-window clamping ok');
