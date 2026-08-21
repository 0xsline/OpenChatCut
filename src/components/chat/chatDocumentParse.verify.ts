import assert from 'node:assert/strict';
import {
  PROJECT_DOCUMENT_MAX_BYTES,
  PROJECT_DOCUMENT_MAX_TEXT_CHARS,
  PROJECT_PDF_MAX_PAGES,
  assertProjectDocumentPageCount,
  assertProjectDocumentSize,
  projectDocumentKind,
  projectFileAssetKind,
  readProjectAssetDocuments,
  readProjectDocument,
  validatedProjectDocumentText,
} from '../../media/projectFile.ts';

assert.doesNotThrow(() => assertProjectDocumentSize(PROJECT_DOCUMENT_MAX_BYTES));
assert.throws(() => assertProjectDocumentSize(PROJECT_DOCUMENT_MAX_BYTES + 1), /10 MB/);
assert.doesNotThrow(() => assertProjectDocumentPageCount(PROJECT_PDF_MAX_PAGES));
assert.throws(() => assertProjectDocumentPageCount(PROJECT_PDF_MAX_PAGES + 1), /100/);
assert.equal(validatedProjectDocumentText('  hello  '), 'hello');
assert.throws(
  () => validatedProjectDocumentText('x'.repeat(PROJECT_DOCUMENT_MAX_TEXT_CHARS + 1)),
  /100,000/,
);
assert.equal(projectDocumentKind({ name: 'brief.json', type: '' } as File), 'text');
assert.equal(projectFileAssetKind({ name: 'design.psd', type: '' } as File), 'file');
assert.equal(await readProjectDocument(new File(['  outline  '], 'outline.md', { type: 'text/markdown' })), 'outline');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response('shot list', { headers: { 'content-type': 'text/plain' } });
const assetDocuments = await readProjectAssetDocuments([{
  id: 'doc-1', name: '分镜.md', sourceFilename: 'storyboard.md', kind: 'document',
  src: '/media/uploads/storyboard.md', durationInFrames: 1,
}]);
globalThis.fetch = originalFetch;
assert.deepEqual(assetDocuments.errors, []);
assert.match(assetDocuments.blocks[0] ?? '', /\[文档: 分镜\.md\]\nshot list/);

console.log('chatDocumentParse.verify: byte, page and extracted-text limits OK');
