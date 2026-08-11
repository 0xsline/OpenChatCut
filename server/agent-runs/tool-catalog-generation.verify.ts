import assert from 'node:assert/strict';
import { normalizeToolCatalogText } from './tool-catalog-generation';

const lf = '{\n  "version": 1\n}\n';
const crlf = lf.replaceAll('\n', '\r\n');
const cr = lf.replaceAll('\n', '\r');

assert.equal(normalizeToolCatalogText(lf), lf);
assert.equal(normalizeToolCatalogText(crlf), lf);
assert.equal(normalizeToolCatalogText(cr), lf);

console.log('tool catalog generation verification passed');
