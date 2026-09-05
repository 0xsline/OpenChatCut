import assert from 'node:assert/strict';
import { assertEditorPersisted } from './browser-tool.ts';
import type { EditorPersistenceSignal, ServerRun } from './store-types.ts';
import type { AgentToolSchema } from '../../src/agent/tool-schema.ts';

function run(persistence?: EditorPersistenceSignal): ServerRun {
  return { editorPersistence: persistence } as unknown as ServerRun;
}
const schema = (name: string): AgentToolSchema => ({ name, input_schema: { type: 'object' } });

const durable: EditorPersistenceSignal = { revision: 4, pending: false, failed: false };
const inFlight: EditorPersistenceSignal = { revision: 3, pending: true, failed: false };
const lost: EditorPersistenceSignal = { revision: 3, pending: false, failed: true };

// A mutating tool whose write is confirmed lost must fail, not report success.
assert.throws(
  () => assertEditorPersisted(run(lost), schema('edit_item'), {}),
  /could not be saved/,
  'edit_item must fail when the editor cannot save',
);
assert.throws(
  () => assertEditorPersisted(run(lost), schema('add_audio'), {}),
  /could not be saved/,
  'add_audio must fail when the editor cannot save',
);

// Reads never touch the project, so a save failure must not fail them: the
// agent still needs to read state in order to report the problem.
assert.doesNotThrow(
  () => assertEditorPersisted(run(lost), schema('read_timeline'), {}),
  'read_timeline must stay usable while saves are failing',
);

// Debounced/in-flight saves are the normal case right after a tool returns and
// must never be treated as loss — that would fail nearly every edit.
assert.doesNotThrow(
  () => assertEditorPersisted(run(inFlight), schema('edit_item'), {}),
  'a pending save is not a failure',
);
assert.doesNotThrow(
  () => assertEditorPersisted(run(durable), schema('edit_item'), {}),
  'a saved revision is not a failure',
);

// Older editors send no signal at all; absence must not break the run.
assert.doesNotThrow(
  () => assertEditorPersisted(run(undefined), schema('edit_item'), {}),
  'a missing signal must be treated as unknown, not failed',
);

console.log('editor-persistence.verify: mutating tools fail on lost writes; reads and pending saves do not');
