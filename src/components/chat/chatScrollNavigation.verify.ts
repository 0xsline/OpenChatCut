import assert from 'node:assert/strict';
import { resolveChatScrollTarget } from './chatScrollNavigation';

const viewport = { scrollHeight: 1200, clientHeight: 400 };

assert.equal(resolveChatScrollTarget({
  previous: { top: 500, time: 100 }, current: { top: 400, time: 200 }, ...viewport,
}), 'top');
assert.equal(resolveChatScrollTarget({
  previous: { top: 300, time: 100 }, current: { top: 400, time: 200 }, ...viewport,
}), 'bottom');
assert.equal(resolveChatScrollTarget({
  previous: { top: 300, time: 100 }, current: { top: 320, time: 200 }, ...viewport,
}), null, 'slow scrolling must not show a shortcut');
assert.equal(resolveChatScrollTarget({
  previous: { top: 100, time: 100 }, current: { top: 0, time: 200 }, ...viewport,
}), null, 'top shortcut must hide at the top edge');
assert.equal(resolveChatScrollTarget({
  previous: { top: 700, time: 100 }, current: { top: 800, time: 200 }, ...viewport,
}), null, 'bottom shortcut must hide at the bottom edge');
assert.equal(resolveChatScrollTarget({
  previous: { top: 300, time: 100 }, current: { top: 400, time: 200 }, suppressUntil: 250, ...viewport,
}), null, 'programmatic scrolling must not show a shortcut');

console.log('chatScrollNavigation.verify: directional fast-scroll behavior OK');
