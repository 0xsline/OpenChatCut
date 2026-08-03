import assert from 'node:assert/strict';
import { placeChatPopover } from './chatPopoverGeometry';

const viewport = { width: 1600, height: 1000 };
const workspace = { left: 0, top: 56, right: 420, bottom: 980 };

const placement = placeChatPopover({
  anchor: { left: 322, top: 900, right: 350, bottom: 928 },
  boundary: workspace,
  viewport,
  requestedWidth: 400,
});

assert.deepEqual(
  placement,
  { left: 12, bottom: 108, width: 400, maxHeight: 280 },
  'popover should open above its trigger while staying inside the Agent workspace',
);

const narrowPlacement = placeChatPopover({
  anchor: { left: 215, top: 910, right: 243, bottom: 938 },
  boundary: { left: 0, top: 56, right: 260, bottom: 980 },
  viewport,
  requestedWidth: 400,
});

assert.equal(narrowPlacement.left, 8, 'narrow workspaces should retain the safe edge gutter');
assert.equal(narrowPlacement.width, 244, 'popover width should shrink to the owning workspace');
assert.ok(narrowPlacement.left + narrowPlacement.width <= 252, 'popover must not enter the adjacent editor pane');

console.log('chatPopoverGeometry.verify: popovers stay inside their Agent workspace');
