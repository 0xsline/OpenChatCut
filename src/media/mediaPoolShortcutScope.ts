export type MediaPoolShortcut = 'select-all' | 'copy' | 'paste' | 'delete' | 'clear-selection';

interface MediaPoolShortcutInput {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export function resolveMediaPoolShortcut(input: MediaPoolShortcutInput): MediaPoolShortcut | null {
  const key = input.key.toLowerCase();
  const mod = input.metaKey || input.ctrlKey;
  if (mod && !input.altKey && !input.shiftKey) {
    if (key === 'a') return 'select-all';
    if (key === 'c') return 'copy';
    if (key === 'v') return 'paste';
  }
  if (!mod && !input.altKey && !input.shiftKey && (key === 'delete' || key === 'backspace')) return 'delete';
  if (!mod && !input.altKey && !input.shiftKey && key === 'escape') return 'clear-selection';
  return null;
}
