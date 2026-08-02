export interface TextContextMenuParams {
  isEditable: boolean;
  selectionText: string;
  editFlags: Partial<Record<
    'canUndo' | 'canRedo' | 'canCut' | 'canCopy' | 'canPaste' | 'canSelectAll',
    boolean
  >>;
}

export type TextContextMenuItem =
  | {
      role: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll';
      enabled: boolean;
    }
  | { type: 'separator' };

/** Build native editing commands without coupling behavior tests to Electron. */
export function buildTextContextMenuTemplate(params: TextContextMenuParams): TextContextMenuItem[] {
  if (!params.isEditable) {
    if (!params.selectionText) return [];
    return [{ role: 'copy', enabled: params.editFlags.canCopy !== false }];
  }

  return [
    { role: 'undo', enabled: !!params.editFlags.canUndo },
    { role: 'redo', enabled: !!params.editFlags.canRedo },
    { type: 'separator' },
    { role: 'cut', enabled: !!params.editFlags.canCut },
    { role: 'copy', enabled: !!params.editFlags.canCopy },
    { role: 'paste', enabled: !!params.editFlags.canPaste },
    { type: 'separator' },
    { role: 'selectAll', enabled: !!params.editFlags.canSelectAll },
  ];
}
