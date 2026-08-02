interface FocusableWindow {
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
}

export function focusExistingWindow(win: FocusableWindow): void {
  if (win.isMinimized()) win.restore();
  win.focus();
}
