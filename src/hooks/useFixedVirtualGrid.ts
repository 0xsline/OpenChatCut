import { useLayoutEffect, useMemo, useRef, useState } from 'react';

export interface FixedVirtualGridOptions {
  itemCount: number;
  cardWidth: number;
  rowHeight: number;
  columnGap?: number;
  rowGap?: number;
  overscanRows?: number;
  fixedColumnCount?: number;
  pinnedIndexes?: readonly number[];
}

export interface FixedVirtualRow {
  rowIndex: number;
  startIndex: number;
  endIndex: number;
  top: number;
}

interface GridWindow {
  width: number;
  columnCount: number;
  startRow: number;
  endRow: number;
}

const INITIAL_WINDOW: GridWindow = {
  width: 0,
  columnCount: 1,
  startRow: 0,
  endRow: 0,
};

function sameWindow(a: GridWindow, b: GridWindow): boolean {
  return a.width === b.width
    && a.columnCount === b.columnCount
    && a.startRow === b.startRow
    && a.endRow === b.endRow;
}

function findScrollContainer(node: HTMLElement): HTMLElement {
  let current = node.parentElement;
  while (current) {
    const overflowY = getComputedStyle(current).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return current;
    current = current.parentElement;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

function columnCountFor(width: number, cardWidth: number, gap: number, fixed?: number): number {
  if (fixed != null) return Math.max(1, fixed);
  return Math.max(1, Math.floor((width + gap) / (cardWidth + gap)));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function useFixedVirtualGrid({
  itemCount,
  cardWidth,
  rowHeight,
  columnGap = 0,
  rowGap = 0,
  overscanRows = 1,
  fixedColumnCount,
  pinnedIndexes = [],
}: FixedVirtualGridOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [gridWindow, setGridWindow] = useState<GridWindow>(INITIAL_WINDOW);
  const rowStride = rowHeight + rowGap;

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const scrollContainer = findScrollContainer(container);
    let animationFrame = 0;

    const measure = () => {
      animationFrame = 0;
      const width = container.clientWidth;
      const columnCount = columnCountFor(width, cardWidth, columnGap, fixedColumnCount);
      const rowCount = Math.ceil(itemCount / columnCount);
      const containerRect = container.getBoundingClientRect();
      const documentScroll = scrollContainer === document.documentElement || scrollContainer === document.body;
      const viewportTop = documentScroll ? 0 : scrollContainer.getBoundingClientRect().top;
      const viewportHeight = documentScroll ? window.innerHeight : scrollContainer.clientHeight;
      const localTop = viewportTop - containerRect.top;
      const localBottom = localTop + viewportHeight;
      const firstVisible = clamp(Math.floor(localTop / rowStride), 0, rowCount);
      const lastVisible = clamp(Math.ceil(localBottom / rowStride), 0, rowCount);
      const nextWindow = {
        width,
        columnCount,
        startRow: Math.max(0, firstVisible - overscanRows),
        endRow: Math.min(rowCount, lastVisible + overscanRows),
      };
      setGridWindow((current) => sameWindow(current, nextWindow) ? current : nextWindow);
    };

    const scheduleMeasure = () => {
      if (!animationFrame) animationFrame = requestAnimationFrame(measure);
    };
    const scrollTarget: EventTarget = scrollContainer === document.documentElement
      || scrollContainer === document.body ? window : scrollContainer;
    scrollTarget.addEventListener('scroll', scheduleMeasure, { passive: true });
    window.addEventListener('resize', scheduleMeasure);
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleMeasure);
    resizeObserver?.observe(container);
    if (scrollContainer !== document.documentElement && scrollContainer !== document.body) {
      resizeObserver?.observe(scrollContainer);
    }
    measure();

    return () => {
      cancelAnimationFrame(animationFrame);
      scrollTarget.removeEventListener('scroll', scheduleMeasure);
      window.removeEventListener('resize', scheduleMeasure);
      resizeObserver?.disconnect();
    };
  }, [cardWidth, columnGap, fixedColumnCount, itemCount, overscanRows, rowStride]);

  const rowCount = Math.ceil(itemCount / gridWindow.columnCount);
  const totalHeight = rowCount === 0 ? 0 : rowCount * rowStride - rowGap;
  const rows = useMemo(() => {
    const indexes = new Set<number>();
    for (let row = gridWindow.startRow; row < gridWindow.endRow; row += 1) indexes.add(row);
    for (const index of pinnedIndexes) {
      if (index >= 0 && index < itemCount) indexes.add(Math.floor(index / gridWindow.columnCount));
    }
    return [...indexes].sort((a, b) => a - b).map<FixedVirtualRow>((rowIndex) => ({
      rowIndex,
      startIndex: rowIndex * gridWindow.columnCount,
      endIndex: Math.min(itemCount, (rowIndex + 1) * gridWindow.columnCount),
      top: rowIndex * rowStride,
    }));
  }, [gridWindow.columnCount, gridWindow.endRow, gridWindow.startRow, itemCount, pinnedIndexes, rowStride]);

  return {
    containerRef,
    columnCount: gridWindow.columnCount,
    columnWidth: Math.min(cardWidth, gridWindow.width),
    rowHeight,
    rows,
    totalHeight,
    visibleStartIndex: gridWindow.startRow * gridWindow.columnCount,
    visibleEndIndex: Math.min(itemCount, gridWindow.endRow * gridWindow.columnCount),
  };
}
