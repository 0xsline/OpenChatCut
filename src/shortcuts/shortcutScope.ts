export type ShortcutSurface =
  | 'media-pool'
  | 'timeline'
  | 'agent-chat'
  | 'agent-input'
  | 'inspector'
  | 'other';

const PROJECT_SHORTCUTS = new Set([
  'undo',
  'redo',
  'save-version',
  'keyboard-shortcuts',
  'ask-ai',
]);

export function shortcutAllowedForSurface(actionId: string, surface: ShortcutSurface): boolean {
  if (PROJECT_SHORTCUTS.has(actionId)) return true;
  return surface === 'timeline';
}

export function shortcutSurfaceFromTarget(target: EventTarget | null): ShortcutSurface {
  if (!(target instanceof Element)) return 'other';
  const surface = target.closest<HTMLElement>('[data-cc-shortcut-surface]')?.dataset.ccShortcutSurface;
  if (
    surface === 'media-pool'
    || surface === 'timeline'
    || surface === 'agent-chat'
    || surface === 'agent-input'
    || surface === 'inspector'
  ) return surface;
  return 'other';
}
