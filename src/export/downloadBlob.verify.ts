// downloadBlob() reached the browser through `window.setTimeout` to defer the
// object-URL revoke. The agent's export tools call these helpers from a runtime
// where `window` does not exist, so the deferred revoke threw AFTER the file had
// already been handed to the browser — a finished export reported as failed.
// Bare setTimeout resolves to the same function in a page and works everywhere.
// (exportClipMov shares the pattern and is covered end-to-end by
// src/agent/tools/timeline-target-tools.verify.ts.)
// npx tsx src/export/downloadBlob.verify.ts
import assert from 'node:assert/strict';

const anchors: Array<{ href: string; download: string; clicked: boolean; removed: boolean }> = [];
let appended = 0;

Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: {
    createElement: () => {
      const anchor = { href: '', download: '', clicked: false, removed: false,
        click() { this.clicked = true; }, remove() { this.removed = true; } };
      anchors.push(anchor);
      return anchor;
    },
    body: { appendChild() { appended += 1; } },
  },
});

// No `window` is defined here on purpose — that is the whole point of the test.
assert.equal(typeof (globalThis as { window?: unknown }).window, 'undefined',
  'the fixture must run without a window global');

// Only the two object-URL statics are stubbed — replacing the whole URL global
// breaks the module loader, which constructs URLs of its own.
const revoked: string[] = [];
const objectUrl = 'blob:openchatcut/test-object-url';
URL.createObjectURL = (() => objectUrl) as typeof URL.createObjectURL;
URL.revokeObjectURL = ((url: string) => { revoked.push(url); }) as typeof URL.revokeObjectURL;

const { downloadBlob } = await import('./exportFiles.ts');

downloadBlob(new Blob(['mov']), 'Target clip.mov');

assert.equal(anchors.length, 1, 'one anchor is created for the download');
assert.equal(anchors[0]!.download, 'Target clip.mov', 'the filename is set on the anchor');
assert.equal(anchors[0]!.href, objectUrl, 'the anchor points at the object URL');
assert.equal(anchors[0]!.clicked, true, 'the download is triggered');
assert.equal(anchors[0]!.removed, true, 'the anchor is cleaned out of the DOM');
assert.equal(appended, 1, 'the anchor was appended before clicking');

// The revoke is deferred, so it must not have run yet — and must not have
// thrown on the way out either.
assert.deepEqual(revoked, [], 'revoking is deferred, not synchronous');
await new Promise((resolve) => setTimeout(resolve, 1_100));
assert.deepEqual(revoked, [objectUrl], 'the object URL is revoked once the delay elapses');

console.log('downloadBlob.verify: downloads and defers its revoke without a window global');
