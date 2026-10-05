import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TextLayer } from './TimelineGraphicLayers';
import { TextControl } from '../components/inspector/InspectorMediaControls';
import { textBackdropBorder, textBackdropColor, textBackdropRgba } from '../components/inspector/textBackdrop';
import type { TimelineItem } from './types';

const title: TimelineItem = {
  id: 'title', kind: 'text', name: 'Title', track: 'V2',
  startFrame: 0, durationInFrames: 60, props: { text: 'Existing title' },
};
const render = (item: TimelineItem) => renderToStaticMarkup(createElement(TextLayer, {
  item, canvasW: 1920, canvasH: 1080, fit: 'contain',
}));
const baseline = render(title);
for (const item of [{ ...title, track: 'V6' }, { ...title, name: 'Sub Title' }, { ...title, name: 'Label New Title' }]) {
  assert.equal(render(item), baseline, 'moving or renaming existing text must preserve its style');
}
const styled = render({ ...title, props: { ...title.props, bgEnabled: true, letterSpacing: 2, lineHeight: 1.5, fontStyle: 'italic' } });
assert.match(styled, /letter-spacing:2px/);
assert.match(styled, /line-height:1.5/);
assert.match(styled, /font-style:italic/);
assert.match(styled, /backdrop-filter:blur/);
assert.match(render({ ...title, props: { fontFamily: 'serif' } }), /font-family:serif;/);
assert.match(render({ ...title, props: { fontFamily: 'Menlo, monospace' } }), /font-family:Menlo, monospace;/);
const redProps = { bgEnabled: true, bgColor: 'rgba(255, 0, 0, 0.4)', bgColorHex: '#000000', bgOpacity: 0.85 };
assert.deepEqual(textBackdropColor(redProps), { hex: '#ff0000', opacity: 0.4 });
assert.equal(textBackdropRgba(textBackdropColor(redProps).hex, 0.7), 'rgba(255, 0, 0, 0.7)');
const inspector = renderToStaticMarkup(createElement(TextControl, { item: { ...title, props: redProps }, onPropChange: () => {} }));
assert.match(inspector, /type="color"[^>]*value="#ff0000"/);
assert.match(inspector, /type="range" min="0" max="1"[^>]*value="0.4"/);
assert.deepEqual(textBackdropBorder({ bgBorder: '4px dashed rgba(255, 0, 0, 0.75)' }), { prefix: '4px dashed', hex: '#ff0000', opacity: 0.75 });
assert.deepEqual(textBackdropColor({ bgColorHex: '#ff0000', bgOpacity: 0.4 }), { hex: '#0a0f1a', opacity: 0.85 });
console.log('TimelineGraphicLayers.verify: legacy defaults and explicit typography/backdrops passed');
