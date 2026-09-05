import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { RawImage } from '@huggingface/transformers';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');
const sharp = require('sharp');

// Exercise the archive and image APIs used by native runtime installation and inference.
const archive = new AdmZip();
archive.addFile('runtime/data.txt', Buffer.from('runtime archive compatible'));
assert.equal(new AdmZip(archive.toBuffer()).readAsText('runtime/data.txt'), 'runtime archive compatible');

const pixels = new Uint8ClampedArray(16).fill(255);
const { data, info } = await sharp(Buffer.from(pixels), { raw: { width: 2, height: 2, channels: 4 } })
  .resize(4, 4).raw().toBuffer({ resolveWithObject: true });
assert.equal(info.width, 4);
assert.equal(data.length, 64);
assert.ok(data.every((channel) => channel === 255));

const resized = await new RawImage(pixels, 2, 2, 4).resize(3, 3);
assert.equal(resized.width, 3);
assert.equal(resized.data.length, 36);
assert.deepEqual([...resized.data.slice(0, 4)], [255, 255, 255, 255]);
console.log('Media dependencies: archive roundtrip, native sharp, and transformers image resize passed');
