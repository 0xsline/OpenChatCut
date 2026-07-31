import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import type { ProjectDoc } from '../editor/types';
import {
  appendAgentChange, createAgentChangeSession, parseAgentChangeLog, rollbackAgentChange,
} from './changeLog';

const doc = (width: number): ProjectDoc => ({
  version: CURRENT_PROJECT_VERSION,
  assets: [],
  mediaFolders: [],
  activeTimelineId: 'timeline',
  timelines: [{
    id: 'timeline', name: 'Sequence', order: 0, fps: 30, width, height: 1080,
    items: [], selectedId: null,
  }],
});

const before = doc(1920);
const after = doc(1080);
const session = createAgentChangeSession(
  '改成竖屏',
  [{ action: '改画面比例', target: '9:16', impact: '1 处改动' }],
  before,
  after,
);
assert.equal(rollbackAgentChange(session, after)?.timelines[0].width, before.timelines[0].width);
assert.equal(rollbackAgentChange(session, doc(720)), null, 'later edits make the rollback stale');
assert.equal(
  rollbackAgentChange(session, doc(720), true)?.timelines[0].width,
  before.timelines[0].width,
  'confirmed rollback restores the saved snapshot despite later edits',
);
assert.equal(
  rollbackAgentChange({ ...session, rollbackable: false }, after, true),
  null,
  'non-rollbackable sessions stay protected',
);
assert.equal(parseAgentChangeLog([{ broken: true }, session]).length, 1, 'corrupt persisted rows are ignored');

let capped = [session];
for (let index = 0; index < 25; index += 1) {
  capped = appendAgentChange(capped, { ...session, id: String(index) });
}
assert.equal(capped.length, 20);

console.log('changeLog.verify: ok');
