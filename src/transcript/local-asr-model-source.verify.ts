import assert from 'node:assert/strict';
import { localAsrLoadError, localAsrModelHosts } from './local-asr-model-source';

assert.deepEqual(localAsrModelHosts('http://127.0.0.1:5199'), [
  'http://127.0.0.1:5199/api/hf-proxy',
]);
assert.deepEqual(localAsrModelHosts('https://editor.example/path'), [
  'https://editor.example/api/hf-proxy',
]);
assert.throws(() => localAsrModelHosts('file:///tmp/editor'), /Unsupported local ASR origin protocol/);
assert.match(
  localAsrLoadError(new Error('proxy unavailable')).message,
  /remote fallback is disabled: proxy unavailable/,
);

console.log('local-asr-model-source.verify: same-origin proxy is the only model host');
