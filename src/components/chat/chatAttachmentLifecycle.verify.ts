import assert from 'node:assert/strict';
import type { AgentReference } from '../../agent/context';
import {
  removeChatAttachmentReference,
  upsertChatAttachmentReference,
} from './chatAttachmentLifecycle';

const existing: AgentReference = { id: 'existing', name: 'Existing.mp4', kind: 'video' };
const placeholder: AgentReference = { id: 'pending', name: 'Pending.mov', kind: 'video' };
const ready: AgentReference = { id: 'pending', name: 'Ready.mov', kind: 'video' };

const withPlaceholder = upsertChatAttachmentReference([existing], placeholder);
assert.deepEqual(withPlaceholder, [existing, placeholder], 'placeholder must be visible before upload completes');
assert.deepEqual(
  upsertChatAttachmentReference(withPlaceholder, ready),
  [existing, ready],
  'ready metadata must replace the placeholder without duplicating its reference',
);
assert.deepEqual(
  removeChatAttachmentReference(withPlaceholder, placeholder.id),
  [existing],
  'a failed progressive import must remove its placeholder reference',
);

console.log('chatAttachmentLifecycle.verify: placeholder/ready/failure transitions OK');
