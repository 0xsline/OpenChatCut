import { useCallback, useEffect, useRef, useState } from 'react';
import type { GlslTransitionType } from '../editor/types';
import { ensureSampleFrame } from '../gl/sampleFrames';
import { GLSL_TRANSITIONS } from '../gl/transitions';
import { customTransitionUniforms, getCustomTransition } from '../gl/customTransitions';
import {
  drawCustomTransitionFrame,
  drawTransitionFrame,
  HOVER_DURATION_MS,
  THUMB_H,
  THUMB_W,
  transitionThumbUrl,
  transitionThumbUrlAsync,
} from '../gl/transitionThumb';

interface TransitionThumbProps {
  /** 内置 GLSL 类型 id,或 plugin:/custom: 注册表 id */
  type: string;
  playing?: boolean;
}

function isBuiltin(type: string): type is GlslTransitionType {
  return type in GLSL_TRANSITIONS;
}

export function TransitionThumb({ type, playing = false }: TransitionThumbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [localHover, setLocalHover] = useState(false);
  const [staticUrl, setStaticUrl] = useState('');
  const active = playing || localHover;
  const custom = !isBuiltin(type) ? getCustomTransition(type) : undefined;

  const paint = useCallback((progress: number) => {
    const c = canvasRef.current;
    if (!c) return;
    if (custom) drawCustomTransitionFrame(c, custom.frag, progress, customTransitionUniforms(custom));
    else if (isBuiltin(type)) drawTransitionFrame(c, type, progress);
  }, [custom, type]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await Promise.all([ensureSampleFrame('out'), ensureSampleFrame('in')]);
      if (cancelled) return;
      if (isBuiltin(type)) {
        const url = await transitionThumbUrlAsync(type);
        if (!cancelled) setStaticUrl(url || transitionThumbUrl(type));
      } else {
        // 自定义/插件:现画一帧作 still(不进全局 cache,id 可热更)
        const off = document.createElement('canvas');
        off.width = THUMB_W;
        off.height = THUMB_H;
        if (custom) {
          drawCustomTransitionFrame(off, custom.frag, 0.42, customTransitionUniforms(custom));
          if (!cancelled) setStaticUrl(off.toDataURL('image/jpeg', 0.85));
        } else if (!cancelled) setStaticUrl('');
      }
      if (!cancelled) paint(0.42);
    })();
    return () => { cancelled = true; };
    // custom 注册表同 id 热更新时靠 type 键重跑
  }, [custom, paint, type]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    if (!active) {
      paint(0.42);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const HOLD = 0.1;
    const tick = (now: number) => {
      const cycle = ((now - t0) % HOVER_DURATION_MS) / HOVER_DURATION_MS;
      let progress: number;
      if (cycle < HOLD) progress = 0;
      else if (cycle > 1 - HOLD) progress = 1;
      else progress = (cycle - HOLD) / (1 - 2 * HOLD);
      paint(progress);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, paint]);

  if (!isBuiltin(type) && !custom) {
    return <span className="cc-resource-thumb-placeholder" />;
  }

  return (
    <div
      className={`cc-live-thumb${active ? ' is-playing' : ''}`}
      onPointerEnter={() => setLocalHover(true)}
      onPointerLeave={() => setLocalHover(false)}
    >
      {staticUrl ? (
        <img className="cc-live-thumb-still" src={staticUrl} alt="" draggable={false} />
      ) : null}
      <canvas
        ref={canvasRef}
        className={`cc-live-thumb-canvas${staticUrl ? '' : ' always-on'}`}
        width={THUMB_W}
        height={THUMB_H}
        aria-hidden
      />
    </div>
  );
}
