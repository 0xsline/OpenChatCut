import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const helper = await import('./resourceTabDrag').catch(() => ({})) as Record<string, unknown>;
const createHorizontalTabDrag = helper.createHorizontalTabDrag as undefined | ((
  start: { clientX: number; clientY: number },
  target: { scrollLeft: number },
) => { move: (point: { clientX: number; clientY: number }) => boolean; end: () => boolean });
const getHorizontalTabRevealDirection = helper.getHorizontalTabRevealDirection as undefined | ((
  currentIndex: number,
  nextIndex: number,
) => 'forward' | 'backward' | 'toggle');
const revealHorizontalTab = helper.revealHorizontalTab as undefined | ((
  container: {
    scrollLeft: number;
    scrollWidth: number;
    clientWidth: number;
    getBoundingClientRect: () => { left: number };
    scrollTo: (options: ScrollToOptions) => void;
  },
  target: { getBoundingClientRect: () => { left: number; right: number } },
  direction: 'forward' | 'backward' | 'toggle',
) => void);

assert.ok(createHorizontalTabDrag, 'template tabs should expose a deliberate horizontal drag gesture');
assert.ok(getHorizontalTabRevealDirection, 'template tabs should resolve directional reveal');
assert.ok(revealHorizontalTab, 'template tabs should reveal the selected chip');

const target = { scrollLeft: 40 };
const drag = createHorizontalTabDrag({ clientX: 100, clientY: 20 }, target);
assert.equal(drag.move({ clientX: 98, clientY: 21 }), false);
assert.equal(drag.move({ clientX: 70, clientY: 22 }), true);
assert.equal(target.scrollLeft, 70);
assert.equal(drag.end(), true);

const verticalTarget = { scrollLeft: 18 };
const verticalGesture = createHorizontalTabDrag({ clientX: 50, clientY: 10 }, verticalTarget);
assert.equal(verticalGesture.move({ clientX: 47, clientY: 28 }), false);
assert.equal(verticalTarget.scrollLeft, 18);

assert.equal(getHorizontalTabRevealDirection(8, 8), 'toggle');
assert.equal(getHorizontalTabRevealDirection(8, 9), 'forward');
assert.equal(getHorizontalTabRevealDirection(8, 7), 'backward');

let revealOptions: ScrollToOptions | undefined;
revealHorizontalTab({
  scrollLeft: 20,
  scrollWidth: 420,
  clientWidth: 180,
  getBoundingClientRect: () => ({ left: 100 }),
  scrollTo: (options) => { revealOptions = options; },
}, {
  getBoundingClientRect: () => ({ left: 188, right: 236 }),
}, 'forward');
assert.deepEqual(revealOptions, { behavior: 'smooth', left: 108 });

const source = await readFile(new URL('./TemplateBrowser.tsx', import.meta.url), 'utf8');
assert.match(source, /createHorizontalTabDrag\(event, event\.currentTarget\)/);
assert.match(source, /aria-selected=\{chip === c\}/);
assert.match(source, /revealHorizontalTab\(/);

console.log('resource-tabs-drag.verify: template category tabs drag and reveal intentionally');
