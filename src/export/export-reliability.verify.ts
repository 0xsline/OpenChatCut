import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  effectiveIncludeMg,
  initialExportDialogJobId,
  suggestedExportFilename,
} from './useExportWorkflow';
import { exportMediaExtension } from './exportMediaExtension';
import type { UseExportWorkflowOptions } from './exportWorkflowTypes';
import { createExportJobStore } from './backgroundExportStore';

const exportStore = createExportJobStore();
const finishedId = exportStore.start({
  label: 'completed.mp4', targetPath: null,
  async execute({ setters }) {
    setters.setProgress((progress) => progress ? { ...progress, phase: 'completed', percent: 100 } : progress);
    setters.setBusy(null);
  },
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(exportStore.getSnapshot().jobs.at(-1)?.progress.phase, 'completed');
assert.equal(initialExportDialogJobId(exportStore.getSnapshot().jobs), null,
  'reopening after a completed export restores the Export action instead of Done');
assert.equal(exportStore.getSnapshot().jobs[0]?.id, finishedId, 'completed export history is retained');

let releaseRender!: () => void;
const activeId = exportStore.start({
  label: 'active.mp4', targetPath: null,
  async execute({ setters }) {
    await new Promise<void>((resolve) => { releaseRender = resolve; });
    setters.setProgress((progress) => progress ? { ...progress, phase: 'completed', percent: 100 } : progress);
    setters.setBusy(null);
  },
});
await Promise.resolve();
assert.equal(initialExportDialogJobId(exportStore.getSnapshot().jobs), activeId,
  'reopening during a render keeps its progress and cancel controls visible');
const newerFinishedId = exportStore.start({
  label: 'newer.mp4', targetPath: null,
  async execute({ setters }) {
    setters.setProgress((progress) => progress ? { ...progress, phase: 'completed', percent: 100 } : progress);
    setters.setBusy(null);
  },
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(initialExportDialogJobId(exportStore.getSnapshot().jobs), activeId,
  'a newer completed job must not hide an older active render');
assert.ok(exportStore.getSnapshot().jobs.some((job) => job.id === newerFinishedId));
releaseRender();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(initialExportDialogJobId(exportStore.getSnapshot().jobs), null);
assert.equal(initialExportDialogJobId([]), null);
const completedJob = exportStore.getSnapshot().jobs[0]!;
for (const phase of ['failed', 'cancelled'] as const) {
  assert.equal(initialExportDialogJobId([{ ...completedJob, progress: { ...completedJob.progress, phase } }]), completedJob.id,
    'failed or cancelled jobs retain their feedback and retry action');
}

const model = readFileSync(new URL('./useExportDialogModel.ts', import.meta.url), 'utf8');

assert.match(
  model,
  /export const DEFAULT_INCLUDE_MG = true;/,
  'editable-project exports should include rendered motion graphics by default',
);

assert.equal(exportMediaExtension('video', 'h264'), 'mp4');
assert.equal(exportMediaExtension('video', 'vp8'), 'webm');
assert.equal(exportMediaExtension('video', 'prores'), 'mov');
assert.equal(exportMediaExtension('audio', 'mp3'), 'mp3');
assert.match(
  model,
  /useState\(DEFAULT_INCLUDE_MG\)/,
  'the dialog state must use the documented default instead of duplicating a literal',
);

const zeroMgXml = {
  tab: 'xml',
  base: 'project',
  codec: 'h264',
  subtitleFormat: 'srt',
  nleFormat: 'fcp_xml',
  includeMg: true,
  mgItems: [],
} as unknown as UseExportWorkflowOptions;
assert.equal(effectiveIncludeMg(zeroMgXml.includeMg, zeroMgXml.mgItems), false);
assert.equal(
  suggestedExportFilename(zeroMgXml),
  'project-final-cut.fcpxml',
  'zero-MG XML exports must request a single-file picker even when the checkbox defaults on',
);
assert.equal(
  suggestedExportFilename({ ...zeroMgXml, tab: 'video', codec: 'prores' }),
  'project.mov',
  'ProRes must use a QuickTime filename at the picker boundary',
);
assert.match(
  model,
  /includeMg: includeAvailableMg, mgItems/,
  'the effective MG flag must also reach XML generation',
);

console.log('export-reliability.verify: editable-project exports default to complete MG packages');
