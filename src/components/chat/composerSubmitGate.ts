export function hasPendingComposerAttachment(
  pasting: boolean | undefined,
  pendingAttachmentCount: number,
): boolean {
  return pasting === true || pendingAttachmentCount > 0;
}

export function isComposerCompositionKey(
  event: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>,
  composing: boolean,
): boolean {
  // The key that ends composition can arrive after compositionend with keyCode 229.
  return composing || event.isComposing || event.keyCode === 229;
}

export function isComposerSendShortcut(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey'>,
): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.altKey;
}
