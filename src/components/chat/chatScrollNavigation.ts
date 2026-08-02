export type ChatScrollTarget = 'top' | 'bottom';

interface ScrollSample {
  top: number;
  time: number;
}

interface ChatScrollNavigationInput {
  previous: ScrollSample;
  current: ScrollSample;
  scrollHeight: number;
  clientHeight: number;
  suppressUntil?: number;
  speedThreshold?: number;
  edgeThreshold?: number;
}

export function resolveChatScrollTarget({
  previous,
  current,
  scrollHeight,
  clientHeight,
  suppressUntil = 0,
  speedThreshold = 0.5,
  edgeThreshold = 4,
}: ChatScrollNavigationInput): ChatScrollTarget | null {
  if (previous.time === 0 || current.time < suppressUntil) return null;
  const delta = current.top - previous.top;
  const elapsed = Math.max(1, current.time - previous.time);
  if (Math.abs(delta) / elapsed < speedThreshold) return null;
  if (delta < 0 && current.top > edgeThreshold) return 'top';
  const remaining = scrollHeight - clientHeight - current.top;
  if (delta > 0 && remaining > edgeThreshold) return 'bottom';
  return null;
}
