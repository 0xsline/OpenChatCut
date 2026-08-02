export interface HorizontalTabDragPoint {
  clientX: number;
  clientY: number;
}

export interface HorizontalTabDragTarget {
  scrollLeft: number;
}

export interface HorizontalTabRevealContainer extends HorizontalTabDragTarget {
  scrollWidth: number;
  clientWidth: number;
  getBoundingClientRect: () => { left: number };
  scrollTo: (options: ScrollToOptions) => void;
}

export interface HorizontalTabRevealTarget {
  getBoundingClientRect: () => { left: number; right: number };
}

export type HorizontalTabRevealDirection = 'forward' | 'backward' | 'toggle';

const DRAG_THRESHOLD_PX = 4;

export function getHorizontalTabRevealDirection(
  currentIndex: number,
  nextIndex: number,
): HorizontalTabRevealDirection {
  if (nextIndex === currentIndex) return 'toggle';
  return nextIndex < currentIndex ? 'backward' : 'forward';
}

export function revealHorizontalTab(
  container: HorizontalTabRevealContainer,
  target: HorizontalTabRevealTarget,
  direction: HorizontalTabRevealDirection,
): void {
  const containerLeft = container.getBoundingClientRect().left;
  const targetRect = target.getBoundingClientRect();
  const containerRight = containerLeft + container.clientWidth;
  let resolvedDirection = direction;
  if (direction === 'toggle') {
    const distanceToLeft = targetRect.left - containerLeft;
    const distanceToRight = containerRight - targetRect.right;
    resolvedDirection = distanceToLeft <= distanceToRight ? 'backward' : 'forward';
  }
  const targetLeft = container.scrollLeft + targetRect.left - containerLeft;
  const targetRight = container.scrollLeft + targetRect.right - containerLeft;
  const nextScrollLeft = resolvedDirection === 'backward'
    ? targetRight - container.clientWidth
    : targetLeft;
  const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
  container.scrollTo({
    behavior: 'smooth',
    left: Math.min(maxScrollLeft, Math.max(0, nextScrollLeft)),
  });
}

/** Keeps tab clicks intact until a deliberate horizontal pointer drag starts. */
export function createHorizontalTabDrag(
  start: HorizontalTabDragPoint,
  target: HorizontalTabDragTarget,
) {
  const initialScrollLeft = target.scrollLeft;
  let dragging = false;

  return {
    move(point: HorizontalTabDragPoint) {
      const deltaX = point.clientX - start.clientX;
      const deltaY = point.clientY - start.clientY;
      if (!dragging) {
        if (Math.abs(deltaX) < DRAG_THRESHOLD_PX || Math.abs(deltaX) <= Math.abs(deltaY)) return false;
        dragging = true;
      }
      target.scrollLeft = initialScrollLeft - deltaX;
      return true;
    },
    end() {
      return dragging;
    },
  };
}
