import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const moduleUrl = new URL('./context-menu.ts', import.meta.url);
assert.equal(existsSync(moduleUrl), true, 'desktop text surfaces need a native editing context menu');

if (existsSync(moduleUrl)) {
  const { buildTextContextMenuTemplate } = await import(moduleUrl.href);

  assert.deepEqual(
    buildTextContextMenuTemplate({
      isEditable: false,
      selectionText: 'selected read-only text',
      editFlags: { canCopy: true },
    }),
    [{ role: 'copy', enabled: true }],
    'selected read-only text exposes Copy',
  );

  assert.deepEqual(
    buildTextContextMenuTemplate({
      isEditable: true,
      selectionText: 'prompt',
      editFlags: {
        canUndo: true,
        canRedo: false,
        canCut: true,
        canCopy: true,
        canPaste: true,
        canSelectAll: true,
      },
    }),
    [
      { role: 'undo', enabled: true },
      { role: 'redo', enabled: false },
      { type: 'separator' },
      { role: 'cut', enabled: true },
      { role: 'copy', enabled: true },
      { role: 'paste', enabled: true },
      { type: 'separator' },
      { role: 'selectAll', enabled: true },
    ],
    'editable fields expose standard native editing commands',
  );

  assert.deepEqual(
    buildTextContextMenuTemplate({
      isEditable: false,
      selectionText: '',
      editFlags: {},
    }),
    [],
    'non-editable surfaces without selected text do not open an empty menu',
  );
}

console.log('desktop context-menu verification passed');
