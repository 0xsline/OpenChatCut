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

const PANEL_WIDTH = 420;
const EDGE_GAP = 8;
const ANCHOR_OFFSET = 190;

export function resolveSemanticPanelRect(
  anchor: RectLike,
  _bounds: RectLike,
  viewport: { width: number; height: number },
  panelHeight: number,
): SemanticPanelRect {
  const width = Math.min(PANEL_WIDTH, Math.max(0, viewport.width - EDGE_GAP * 2));
  const left = Math.min(
    Math.max(anchor.left - ANCHOR_OFFSET, EDGE_GAP),
    Math.max(EDGE_GAP, viewport.width - width - EDGE_GAP),
  );
  const below = anchor.bottom + 6;
  const top = below + panelHeight <= viewport.height - EDGE_GAP
    ? below
    : Math.max(EDGE_GAP, anchor.top - panelHeight - 6);
  return { top, left, width };
}
