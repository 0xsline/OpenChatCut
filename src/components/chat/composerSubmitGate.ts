export function hasPendingComposerAttachment(
  pasting: boolean | undefined,
  pendingAttachmentCount: number,
): boolean {
  return pasting === true || pendingAttachmentCount > 0;
}

export function shouldSubmitComposerOnKeyDown(
  key: string,
  shiftKey: boolean,
  canSend: boolean,
): boolean {
  return key === 'Enter' && !shiftKey && canSend;
}
