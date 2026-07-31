export interface SemanticPanelRect {
  top: number;
  left: number;
  width: number;
}

interface RectLike {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
}

const PANEL_WIDTH = 340;
const EDGE_GAP = 8;
const ANCHOR_OFFSET = 190;

export function resolveSemanticPanelRect(
  anchor: RectLike,
  bounds: RectLike,
  viewport: { width: number; height: number },
  panelHeight: number,
): SemanticPanelRect {
  const width = Math.min(PANEL_WIDTH, bounds.width - EDGE_GAP * 2, viewport.width - EDGE_GAP * 2);
  const left = Math.min(
    Math.max(anchor.left - ANCHOR_OFFSET, bounds.left + EDGE_GAP),
    bounds.right - width - EDGE_GAP,
  );
  const below = anchor.bottom + 6;
  const top = below + panelHeight <= viewport.height - EDGE_GAP
    ? below
    : Math.max(EDGE_GAP, anchor.top - panelHeight - 6);
  return { top, left, width };
}
