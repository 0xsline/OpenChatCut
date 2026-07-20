// Runnable check for pending proposal IDB parse/round-trip:
// `npx tsx src/persist/proposalStore.check.ts`.
import assert from 'node:assert';
import { makeDraft } from '../editor/store';
import { buildOperation, buildProposal, isProposalStale } from '../agent/proposal';
import type { ProjectDoc, Timeline } from '../editor/types';
import {
  clearProposal, loadProposal, parseProposal, resetProposalStoreMemory, saveProposal,
} from './proposalStore';

const tl = (id: string): Timeline =>
  ({ fps: 30, width: 1920, height: 1080, items: [], selectedId: null, id, name: id, order: 0 });

const base: ProjectDoc = {
  version: 2, assets: [], mediaFolders: [],
  timelines: [tl('tl_a')], activeTimelineId: 'tl_a',
};

const draft = makeDraft(base);
draft.commands.addTextClip();
const acts = draft.takeActions();
const proposal = buildProposal(
  [buildOperation('add_text', {}, acts)],
  'add a title',
  base,
  draft.getState(),
);

// Reject junk
assert.strictEqual(parseProposal(null), null);
assert.strictEqual(parseProposal({ title: 'x' }), null);
assert.strictEqual(parseProposal({ ...proposal, options: [] }), null);

// Accept a structured clone (what IDB effectively stores)
const cloned = JSON.parse(JSON.stringify(proposal));
const parsed = parseProposal(cloned);
assert.ok(parsed, 'cloned proposal parses');
assert.strictEqual(parsed!.title, proposal.title);
assert.strictEqual(parsed!.options[0].operations.length, 1);
assert.strictEqual(parsed!.options[0].operations[0].actions[0].type, 'add');
assert.strictEqual(isProposalStale(parsed!, base), false, 'parsed proposal applies to same content');

// Memory-store round-trip (Node has no indexedDB)
resetProposalStoreMemory();
const pid = 'proj_test';
await saveProposal(pid, proposal);
const loaded = await loadProposal(pid);
assert.ok(loaded, 'load after save');
assert.strictEqual(loaded!.summary, proposal.summary);
assert.strictEqual(isProposalStale(loaded!, base), false);

await clearProposal(pid);
assert.strictEqual(await loadProposal(pid), null, 'clear removes pending proposal');

// Stale after real project change
const changed = makeDraft(base);
changed.commands.addTextClip();
const afterEdit = changed.getDoc();
assert.strictEqual(isProposalStale(loaded ?? proposal, afterEdit), true);

console.log('proposalStore.check: ok');
