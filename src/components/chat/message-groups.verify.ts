import assert from 'node:assert/strict';
import type { DisplayMessage } from '../../agent/useAgent';
import { groupMessages } from './message-groups';

const messages = [
  { role: 'user', text: 'one' },
  { role: 'assistant', text: 'two' },
] as DisplayMessage[];

assert.deepEqual(groupMessages(messages, 40).map((item) => item.index), [40, 41]);
console.log('message-groups.verify: ok');
