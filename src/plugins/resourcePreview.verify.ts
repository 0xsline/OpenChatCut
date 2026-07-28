import assert from 'node:assert/strict';

import { asPluginZoom, pluginTemplates } from '../library/pluginResources';
import type { InstalledPack } from './store';
import { validatePack } from './validate';

const pack: InstalledPack = {
  format: 'openchatcut-plugin@1',
  id: 'preview-check',
  name: 'Preview check',
  version: '1.0.0',
  installedAt: 0,
  enabled: true,
  items: [
    {
      id: 'mg',
      name: 'MG',
      type: 'mg-template',
      durationInFrames: 90,
      code: 'return function Demo(){return React.createElement("div", null, "ok")}',
    },
    {
      id: 'zoom',
      name: 'Zoom',
      type: 'zoom',
      shape: 'punch',
      magnification: 1.5,
    },
    {
      id: 'lut',
      name: 'LUT',
      type: 'lut',
      frag: 'uniform sampler2D u_input; void main(){ vec4 c = texture(u_input, vec2(0.0)); }',
    },
  ],
};

assert.equal(validatePack(pack).ok, true);
assert.equal(pluginTemplates([pack])[0]?.durationInFrames, 90);
assert.deepEqual(
  asPluginZoom({ shape: 'punch', magnification: 1.5 }),
  { shape: 'punch', magnification: 1.5 },
);

console.log('resourcePreview.verify: all assertions passed');
