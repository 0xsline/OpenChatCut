interface RulerScrubOptions {
  headerWidth: number;
  pixelsPerFrame: number;
  totalFrames: number;
  seekTo(clientX: number): void;
}

const HANDLE_HALF_WIDTH = 6;
const BASE_SCROLL_SPEED = 480;
const MAX_SCROLL_SPEED = 1440;

/** Keep a captured ruler drag inside the clip area and scroll the content at its edges. */
export function startTimelineRulerScrub(
  ruler: HTMLElement,
  viewport: HTMLElement,
  pointerId: number,
  startX: number,
  getOptions: () => RulerScrubOptions,
): () => void {
  let pointerX = startX;
  let raf = 0;
  let lastTime = 0;
  let previousX = startX;
  let previousScroll = viewport.scrollLeft;
  let stopped = false;
  const cursor = ruler.style.cursor;

  function update(now: number, advanceScroll: boolean) {
    const { headerWidth, pixelsPerFrame, totalFrames, seekTo } = getOptions();
    const viewportLeft = viewport.getBoundingClientRect().left + viewport.clientLeft;
    const inset = HANDLE_HALF_WIDTH + pixelsPerFrame / 2;
    const left = viewportLeft + headerWidth + inset;
    const right = viewportLeft + viewport.clientWidth - inset;
    if (right <= left) return;

    const edgeX = Math.max(left, Math.min(pointerX, right));
    const overshoot = pointerX - edgeX;
    const direction = Math.sign(overshoot);
    const lastFrameX = headerWidth + Math.max(0, totalFrames - 1) * pixelsPerFrame;
    const limit = Math.max(0, Math.min(
      viewport.scrollWidth - viewport.clientWidth,
      Math.ceil(lastFrameX - (right - viewportLeft)),
    ));
    const canScroll = () => direction < 0 ? viewport.scrollLeft > 0 : direction > 0 && viewport.scrollLeft < limit;
    if (advanceScroll && canScroll()) {
      const speed = Math.min(MAX_SCROLL_SPEED, BASE_SCROLL_SPEED + Math.abs(overshoot) * 8);
      const delta = Math.max(1, speed * Math.min(40, now - lastTime) / 1000);
      const bound = direction < 0 ? 0 : limit;
      const step = Math.min(delta, Math.abs(viewport.scrollLeft - bound));
      viewport.scrollLeft += direction * step;
    }

    // At the true left boundary, let the drag reach frame zero.
    const seekX = direction < 0 && viewport.scrollLeft === 0 ? viewportLeft + headerWidth : edgeX;
    if (seekX !== previousX || viewport.scrollLeft !== previousScroll) {
      previousX = seekX;
      previousScroll = viewport.scrollLeft;
      seekTo(seekX);
    }
    if (canScroll() && !raf) {
      lastTime = now;
      raf = requestAnimationFrame(tick);
    }
  }

  function tick(now: number) {
    raf = 0;
    update(now, true);
  }

  function move(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    pointerX = event.clientX;
    update(performance.now(), false);
  }

  function finish(event: PointerEvent) {
    if (event.pointerId === pointerId) stop();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (raf) cancelAnimationFrame(raf);
    ruler.removeEventListener('pointermove', move);
    ruler.removeEventListener('pointerup', finish);
    ruler.removeEventListener('pointercancel', finish);
    ruler.removeEventListener('lostpointercapture', finish);
    ruler.style.cursor = cursor;
    if (ruler.hasPointerCapture(pointerId)) ruler.releasePointerCapture(pointerId);
  }

  ruler.setPointerCapture(pointerId);
  ruler.style.cursor = 'grabbing';
  ruler.addEventListener('pointermove', move);
  ruler.addEventListener('pointerup', finish);
  ruler.addEventListener('pointercancel', finish);
  ruler.addEventListener('lostpointercapture', finish);
  getOptions().seekTo(startX);
  return stop;
}
