import assert from 'node:assert/strict';
import { isTimelineDragOverChat } from './timelineChatDrop';

const composer = { left: 20, right: 340, top: 480, bottom: 760 };
assert.equal(isTimelineDragOverChat(200, 620, composer), true, 'release inside the composer becomes an AI reference drop');
assert.equal(isTimelineDragOverChat(19, 620, composer), false, 'release outside the composer remains a timeline gesture');
assert.equal(isTimelineDragOverChat(200, 760, composer), false, 'the lower composer boundary is exclusive');

console.log('timeline chat drop verify passed');
