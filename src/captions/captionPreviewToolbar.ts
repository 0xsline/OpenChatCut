export interface CaptionPreviewOutsideClickInput {
  editing: boolean;
  popoverOpen: boolean;
  insideEditor: boolean;
  insideToolbar: boolean;
  draftChanged: boolean;
}

export interface CaptionPreviewOutsideClickAction {
  closeEditor: boolean;
  commitDraft: boolean;
  closePopover: boolean;
}

export function captionPreviewOutsideClickAction({
  editing,
  popoverOpen,
  insideEditor,
  insideToolbar,
  draftChanged,
}: CaptionPreviewOutsideClickInput): CaptionPreviewOutsideClickAction {
  // Native capture runs before a toolbar button's React click. Keeping the
  // editor mounted for toolbar pointerdown prevents the pending click from
  // being cancelled by a re-render.
  const closeEditor = editing && !insideEditor && !insideToolbar;
  return {
    closeEditor,
    commitDraft: closeEditor && draftChanged,
    closePopover: popoverOpen && !insideToolbar,
  };
}
