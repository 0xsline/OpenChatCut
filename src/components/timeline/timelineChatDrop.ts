export interface TimelineChatDropBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Keep normal timeline pointer capture; only a release inside the composer becomes a reference drop. */
export function isTimelineDragOverChat(
  clientX: number,
  clientY: number,
  bounds: TimelineChatDropBounds,
): boolean {
  return clientX >= bounds.left && clientX < bounds.right
    && clientY >= bounds.top && clientY < bounds.bottom;
}
