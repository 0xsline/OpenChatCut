// Runnable check: `npx tsx src/agent/tools/read-project-tools.verify.ts`.
import assert from 'node:assert/strict';
import { activeEditorState } from '../../editor/types';
import { CURRENT_PROJECT_VERSION } from '../../../shared/project-version.js';
import type { ProjectDoc, Timeline } from '../../editor/types';
import type { AgentContext } from '../context';
import { execReadProjectTool } from './read-project-tools';
import { READ_PROJECT_TOOL_SCHEMAS } from './schemas/read-project-tools';

const timeline: Timeline = {
  id: 'timeline-active',
  name: 'Active',
  order: 0,
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  tracks: { video: { kind: 'video' } },
  trackOrder: ['video'],
  items: [],
};
const doc: ProjectDoc = {
  version: CURRENT_PROJECT_VERSION,
  assets: [],
  mediaFolders: [],
  timelines: [timeline],
  activeTimelineId: timeline.id,
};
const context = {
  commands: {},
  getState: () => activeEditorState(doc),
  getDoc: () => doc,
  getCreativeMode: () => null,
  templates: [],
  audio: [],
  getProjectId: () => 'session-project',
} as unknown as AgentContext;

const filtered = await execReadProjectTool(
  'read_project',
  { projectId: 'ignored-other-project', itemId: 'missing', assetId: 'missing' },
  context,
);
if (!filtered || typeof filtered !== 'object'
  || !('projectId' in filtered) || !('timeline' in filtered) || !('mediaPool' in filtered)) {
  assert.fail('read_project should return the documented overview object');
}
assert.equal(filtered.projectId, 'session-project', 'projectId input cannot retarget the current session');
const timelineResult = filtered.timeline;
const mediaPoolResult = filtered.mediaPool;
if (!timelineResult || typeof timelineResult !== 'object' || !('items' in timelineResult)) {
  assert.fail('timeline overview should contain items');
}
if (!mediaPoolResult || typeof mediaPoolResult !== 'object' || !('assets' in mediaPoolResult)) {
  assert.fail('media-pool overview should contain assets');
}
assert.deepEqual(timelineResult.items, [], 'unmatched item filters return an empty array');
assert.deepEqual(mediaPoolResult.assets, [], 'unmatched asset filters return an empty array');

const missingTimeline = await execReadProjectTool(
  'read_project',
  { timelineId: 'missing' },
  context,
);
if (!missingTimeline || typeof missingTimeline !== 'object' || !('error' in missingTimeline)) {
  assert.fail('missing timeline should return an error object');
}
assert.match(String(missingTimeline.error ?? ''), /timeline/i, 'unknown timeline references return an error');

const schemaDescription = READ_PROJECT_TOOL_SCHEMAS[0]!.description ?? '';
assert.match(schemaDescription, /currently targeted by this agent session/);
assert.match(schemaDescription, /return an error/);
assert.match(schemaDescription, /empty item\/asset arrays/);

console.log('read-project-tools.verify: session targeting and documented failure/filter semantics ok');
