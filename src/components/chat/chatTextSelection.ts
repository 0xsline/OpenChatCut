export interface ChatTextShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey?: boolean;
}

export type ChatTextShortcut = 'select-all';

const CHAT_TEXT_SELECTION_EXCLUSIONS = 'a, button, input, textarea, select, [contenteditable="true"], [role="textbox"], [data-cc-shortcut-surface="agent-input"]';

export function resolveChatTextShortcut(event: ChatTextShortcutEvent): ChatTextShortcut | null {
  if (event.altKey || event.shiftKey) return null;
  if (!(event.metaKey || event.ctrlKey)) return null;
  return event.key.toLowerCase() === 'a' ? 'select-all' : null;
}

export function shouldHandleChatTextSelection(
  event: ChatTextShortcutEvent,
  target: Pick<HTMLElement, 'closest'>,
): boolean {
  return resolveChatTextShortcut(event) === 'select-all'
    && !target.closest(CHAT_TEXT_SELECTION_EXCLUSIONS);
}

interface ChatSelectionEnvironment {
  selection: Selection | null;
  createRange: () => Range;
}

export function selectChatMessageContents(
  element: HTMLElement | null,
  environment?: ChatSelectionEnvironment,
): boolean {
  if (!element) return false;
  const selection = environment?.selection ?? window.getSelection();
  if (!selection) return false;
  const range = environment?.createRange() ?? document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}
