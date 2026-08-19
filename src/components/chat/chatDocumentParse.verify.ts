import assert from 'node:assert/strict';
import {
  CHAT_DOCUMENT_MAX_BYTES,
  CHAT_DOCUMENT_MAX_TEXT_CHARS,
  CHAT_PDF_MAX_PAGES,
  assertChatDocumentPageCount,
  assertChatDocumentSize,
  validatedChatDocumentText,
} from './chatDocumentLimits.ts';

assert.doesNotThrow(() => assertChatDocumentSize(CHAT_DOCUMENT_MAX_BYTES));
assert.throws(() => assertChatDocumentSize(CHAT_DOCUMENT_MAX_BYTES + 1), /10 MB/);
assert.doesNotThrow(() => assertChatDocumentPageCount(CHAT_PDF_MAX_PAGES));
assert.throws(() => assertChatDocumentPageCount(CHAT_PDF_MAX_PAGES + 1), /100/);
assert.equal(validatedChatDocumentText('  hello  '), 'hello');
assert.throws(
  () => validatedChatDocumentText('x'.repeat(CHAT_DOCUMENT_MAX_TEXT_CHARS + 1)),
  /100,000/,
);

console.log('chatDocumentParse.verify: byte, page and extracted-text limits OK');
