import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { historyReduce, type History } from '../editor/reduce';
import type { ProjectDoc } from '../editor/types';
import {
  AUTO_GRADE_LIMITS,
  analyzeSignalFrames,
  createColorStreamProfile,
  inferBitDepth,
  normalizeSignalValue,
  recommendAutoGrade,
  summarizeSignalFrames,
} from './autoGradeCore';

assert.equal(inferBitDepth({ pix_fmt: 'yuv420p' }), 8);
assert.equal(inferBitDepth({ pix_fmt: 'yuv420p10le' }), 10);
assert.equal(inferBitDepth({ pix_fmt: 'gbrp12le' }), 12);
assert.equal(inferBitDepth({ pix_fmt: 'gbrap10le' }), 10);
assert.equal(inferBitDepth({ pix_fmt: 'p010le' }), 10);
assert.equal(inferBitDepth({ pix_fmt: 'p210le' }), 10);
assert.equal(inferBitDepth({ pix_fmt: 'x2rgb10le' }), 10);
assert.equal(inferBitDepth({ pix_fmt: 'yuv420p', bits_per_raw_sample: '10' }), 10);
assert.equal(normalizeSignalValue(255, 8), 1);
assert.equal(normalizeSignalValue(1023, 10), 1);

const profile8 = createColorStreamProfile({ pix_fmt: 'yuv420p', color_transfer: 'bt709' });
const profile10 = createColorStreamProfile({ pix_fmt: 'yuv420p10le', color_transfer: 'bt709' });
const stats8 = summarizeSignalFrames([{
  yLow: 26,
  yAverage: 128,
  yHigh: 230,
  saturationAverage: 64,
}], profile8);
const stats10 = summarizeSignalFrames([{
  yLow: 104,
  yAverage: 513,
  yHigh: 923,
  saturationAverage: 257,
}], profile10);
assert.ok(Math.abs(stats8.yMean - stats10.yMean) < 0.002, '8/10-bit luma normalization must agree');
assert.ok(Math.abs(stats8.yRange - stats10.yRange) < 0.002, '8/10-bit range normalization must agree');
assert.ok(Math.abs(stats8.saturationMean - stats10.saturationMean) < 0.002, '8/10-bit saturation normalization must agree');

const sdr = recommendAutoGrade({ sampleCount: 10, yMean: 0.2, yRange: 0.3, saturationMean: 0.05 }, { hdr: false });
assert.equal(sdr.filters.brightness, AUTO_GRADE_LIMITS.brightness.max);
assert.equal(sdr.filters.contrast, AUTO_GRADE_LIMITS.contrast.max);
assert.ok(sdr.filters.saturate <= AUTO_GRADE_LIMITS.saturate.max);

const hdr = recommendAutoGrade({ sampleCount: 10, yMean: 0.2, yRange: 0.3, saturationMean: 0.05 }, { hdr: true });
for (const value of Object.values(hdr.filters)) {
  assert.ok(value >= 1 - AUTO_GRADE_LIMITS.hdrDelta && value <= 1 + AUTO_GRADE_LIMITS.hdrDelta);
}

const analysis = analyzeSignalFrames([{
  yMin: 0,
  yLow: 160,
  yAverage: 450,
  yHigh: 850,
  yMax: 1023,
  saturationAverage: 220,
}], createColorStreamProfile({
  pix_fmt: 'yuv420p10le',
  bits_per_raw_sample: '10',
  color_transfer: 'smpte2084',
  color_primaries: 'bt2020',
  color_space: 'bt2020nc',
}));
assert.equal(analysis.profile.bitDepth, 10);
assert.equal(analysis.profile.hdr, true);
assert.equal(analysis.stats.sampleCount, 1);
assert.deepEqual(Object.keys(analysis.filters).sort(), ['brightness', 'contrast', 'saturate']);

const project: ProjectDoc = {
  version: CURRENT_PROJECT_VERSION,
  assets: [],
  mediaFolders: [],
  activeTimelineId: 'timeline',
  timelines: [{
    id: 'timeline',
    name: 'Timeline',
    order: 0,
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: 'clip-a',
    selectedIds: ['clip-a', 'clip-b'],
    items: [
      { id: 'clip-a', track: 'video', startFrame: 0, durationInFrames: 30, kind: 'video', name: 'A', src: '/media/uploads/a.mp4' },
      { id: 'clip-b', track: 'video', startFrame: 30, durationInFrames: 30, kind: 'video', name: 'B', src: '/media/uploads/b.mp4' },
    ],
  }],
};
const history: History = { past: [], present: project, future: [] };
const corrected = historyReduce(history, {
  type: 'batch',
  label: 'Apply automatic color correction',
  actions: [
    { type: 'setFilters', id: 'clip-a', patch: { brightness: 1.04, contrast: 1.03, saturate: 0.98 } },
    { type: 'setFilters', id: 'clip-b', patch: { brightness: 0.97, contrast: 1.05, saturate: 1.02 } },
  ],
});
assert.equal(corrected.past.length, 1, 'a multi-clip correction must create one history entry');
assert.equal(corrected.present.timelines[0]!.items[0]!.filters?.brightness, 1.04);
assert.equal(corrected.present.timelines[0]!.items[1]!.filters?.brightness, 0.97);
const undone = historyReduce(corrected, { type: 'undo' });
assert.equal(undone.present.timelines[0]!.items[0]!.filters, undefined);
assert.equal(undone.present.timelines[0]!.items[1]!.filters, undefined);

console.log('autoGrade.verify: ok');
