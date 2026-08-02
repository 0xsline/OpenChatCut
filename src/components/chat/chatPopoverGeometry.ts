export interface PopoverRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ChatPopoverPlacement {
  left: number;
  bottom: number;
  width: number;
  maxHeight: number;
}

const EDGE_GUTTER = 8;
const MENU_MAX_HEIGHT = 280;

export function placeChatPopover({ anchor, boundary, viewport, requestedWidth }: {
  anchor: PopoverRect;
  boundary: PopoverRect;
  viewport: { width: number; height: number };
  requestedWidth: number;
}): ChatPopoverPlacement {
  const leftEdge = Math.max(EDGE_GUTTER, boundary.left + EDGE_GUTTER);
  const rightEdge = Math.min(viewport.width - EDGE_GUTTER, boundary.right - EDGE_GUTTER);
  const width = Math.max(0, Math.min(requestedWidth, rightEdge - leftEdge));
  const left = Math.min(Math.max(anchor.left, leftEdge), Math.max(leftEdge, rightEdge - width));
  const boundaryBottom = Math.max(EDGE_GUTTER, viewport.height - boundary.bottom + EDGE_GUTTER);
  const bottom = Math.max(boundaryBottom, viewport.height - anchor.top + EDGE_GUTTER);
  const maxHeight = Math.max(0, Math.min(MENU_MAX_HEIGHT, anchor.top - boundary.top - EDGE_GUTTER * 2));

  return { left, bottom, width, maxHeight };
}
