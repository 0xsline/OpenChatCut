import type { AgentReference } from '../../agent/context';

export function upsertChatAttachmentReference(
  current: readonly AgentReference[],
  next: AgentReference,
): AgentReference[] {
  const index = current.findIndex((reference) => reference.id === next.id);
  if (index < 0) return [...current, next];
  return current.map((reference, itemIndex) => itemIndex === index ? next : reference);
}

export function removeChatAttachmentReference(
  current: readonly AgentReference[],
  id: string,
): AgentReference[] {
  return current.filter((reference) => reference.id !== id);
}
