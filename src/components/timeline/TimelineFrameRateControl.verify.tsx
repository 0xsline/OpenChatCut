// Issue #175: the timeline toolbar offers the project frame rate next to the
// aspect-ratio picker. Run: npx tsx --tsconfig tsconfig.app.json src/components/timeline/TimelineFrameRateControl.verify.tsx
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { formatFrameRate, FRAME_RATE_LOCKED_REASON } from '../../editor/timelineFrameRate';
import { TimelineFrameRateControlView } from './TimelineFrameRateControl';

const noop = () => undefined;
const translate = (key: string) => key;
const optionValues = (html: string) => [...html.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);

const open = renderToStaticMarkup(<TimelineFrameRateControlView fps={30} lock={null} onChange={noop} translate={translate} />);
assert.deepEqual(optionValues(open), ['24', '25', '30', '50', '60'], 'only natively exportable rates');
assert.match(open, /<option value="30" selected="">30 fps<\/option>/, 'the current rate is selected');
assert.match(open, /<span aria-hidden="true">30 fps<\/span>/, 'the rate is visible without opening the menu');
assert.doesNotMatch(open, /<select[^>]*disabled/, 'an empty project can change its rate');
assert.match(open, /data-tip="时间线帧率"/);

const locked = renderToStaticMarkup(
  <TimelineFrameRateControlView fps={60} lock={FRAME_RATE_LOCKED_REASON} onChange={noop} translate={translate} />,
);
assert.match(locked, /<select[^>]*disabled=""/, 'placed media locks the rate');
assert.match(locked, new RegExp(`data-tip="${FRAME_RATE_LOCKED_REASON}"`), 'the tooltip says why');
assert.match(locked, /class="[^"]*is-locked/);

// A rate set outside the GUI (MCP create_project fps: 59.94) is shown as it
// is, but cannot be picked again once left.
const ntsc = renderToStaticMarkup(
  <TimelineFrameRateControlView fps={60000 / 1001} lock={null} onChange={noop} translate={translate} />,
);
assert.equal(formatFrameRate(60000 / 1001), '59.94');
assert.match(ntsc, /<option value="59\.94005994005994" disabled="" selected="">59\.94 fps<\/option>/);
assert.deepEqual(optionValues(ntsc).slice(1), ['24', '25', '30', '50', '60']);

// Wired where the canvas settings live, fed by the project-wide lock.
const toolbar = readFileSync(new URL('./TimelineToolbar.tsx', import.meta.url), 'utf8');
assert.match(toolbar, /<TimelineFrameRateControl fps=\{state\.fps\} lock=\{frameRateLock\} onChange=\{commands\.setProjectFps\} \/>/);
const controller = readFileSync(new URL('../../editor/useEditorController.tsx', import.meta.url), 'utf8');
assert.match(controller, /frameRateLock: projectFrameRateLock\(doc\)/);

console.log('TimelineFrameRateControl.verify: rates, lock and non-standard current rate render correctly');
