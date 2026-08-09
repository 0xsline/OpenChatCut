import assert from 'node:assert/strict';
import { parseWidgets, safeWidgetMediaUrl } from './widget-parse';

const base = 'https://openchatcut.local/editor';

assert.equal(safeWidgetMediaUrl('/media/preview.png', base), 'https://openchatcut.local/media/preview.png');
assert.equal(safeWidgetMediaUrl('voice/sample.mp3', base), 'https://openchatcut.local/voice/sample.mp3');
assert.equal(safeWidgetMediaUrl('blob:https://openchatcut.local/id', base), 'blob:https://openchatcut.local/id');
assert.equal(safeWidgetMediaUrl('data:image/png;base64,AA==', base), 'data:image/png;base64,AA==');
assert.equal(safeWidgetMediaUrl('data:image/svg+xml,<svg/>', base), null);
assert.equal(safeWidgetMediaUrl('https://tracker.example/pixel.png', base), null);
assert.equal(safeWidgetMediaUrl('http://127.0.0.1:3000/admin.png', base), null);
assert.equal(safeWidgetMediaUrl('javascript:alert(1)', base), null);

assert.deepEqual(parseWidgets('<widget><form-single id="style" label="Style"/></widget>'), [],
  'widget markup without renderable fields does not leave an empty placeholder');
assert.deepEqual(parseWidgets('  <widget><form-text id="note"/></widget>  '), [],
  'invalid widget markup and surrounding whitespace render nothing');
assert.deepEqual(parseWidgets('Keep this text.'), [{ type: 'text', text: 'Keep this text.' }],
  'ordinary assistant text remains visible');

console.log('widget media URL checks passed');
