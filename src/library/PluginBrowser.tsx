// Extended resource runtime preview; resource data conversion in pluginResources.
import { useCallback, useEffect, useRef, useState } from 'react';
import { sampleEnvelope } from '../editor/zoom';
import { ensureSampleFrame, getSampleFrame, SAMPLE_H, SAMPLE_W } from '../gl/sampleFrames';
import { theme } from '../theme';

/** Plug-in scaling curve:real sample + Envelope driven scaling,hover broadcast 0→1(with built-in ZoomThumb Same view) */
export function EnvelopeThumb({
  envelope,
  magnification = 1.5,
  playing = false,
}: {
  envelope: number[];
  magnification?: number;
  playing?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [localHover, setLocalHover] = useState(false);
  const [ready, setReady] = useState(false);
  const active = playing || localHover;

  const paint = useCallback((t: number) => {
    const c = canvasRef.current;
    const sample = getSampleFrame('fx');
    if (!c || !sample) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const W = SAMPLE_W;
    const H = SAMPLE_H;
    const env = Math.max(0, sampleEnvelope(envelope, t));
    // Slightly exaggerated magnification to make it easier to read on the card
    const peak = Math.max(magnification, 1.8);
    const scale = 1 + (peak - 1) * env;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    const fx = W * 0.38;
    const fy = H * 0.42;
    ctx.translate(fx, fy);
    ctx.scale(scale, scale);
    ctx.translate(-fx, -fy);
    ctx.drawImage(sample, 0, 0, W, H);
    ctx.restore();
  }, [envelope, magnification]);

  useEffect(() => {
    let cancelled = false;
    ensureSampleFrame('fx').then(() => {
      if (cancelled) return;
      setReady(true);
      paint(0.45);
    });
    return () => { cancelled = true; };
  }, [paint]);

  useEffect(() => {
    if (!ready) return;
    if (!active) {
      paint(0.45);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const DUR = 1400;
    const tick = (now: number) => {
      const t = ((now - t0) % DUR) / DUR;
      paint(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, paint, ready]);

  return (
    <div
      className={`cc-live-thumb${active ? ' is-playing' : ''}`}
      onPointerEnter={() => setLocalHover(true)}
      onPointerLeave={() => setLocalHover(false)}
    >
      <canvas
        ref={canvasRef}
        className="cc-live-thumb-canvas always-on"
        width={SAMPLE_W}
        height={SAMPLE_H}
        aria-hidden
      />
    </div>
  );
}

/** Plugin item preview card(pack.thumb data URL / URL) */
export function PluginImgThumb({ src, name }: { src: string; name: string }) {
  // impeccable-disable-next-line broken-image -- src comes from the installed and verified plug-in package (data:image/* or URL)
  return <img src={src} alt={name} draggable={false} style={{ width: '100%', height: '100%', minHeight: 56, objectFit: 'cover', borderRadius: 6, display: 'block' }} />;
}

/** Plug-in transition thumbnail:initials(Built-in TransitionThumb Only recognize the registry GLSL Type) */
export function PluginNameThumb({ name }: { name: string }) {
  return (
    <div style={{
      width: '100%', height: '100%', minHeight: 56, display: 'grid', placeItems: 'center',
      background: theme.panelAlt, border: `0.5px solid ${theme.border}`, borderRadius: 4,
      fontSize: 20, color: theme.textMuted, fontWeight: 700,
    }}>
      {name.slice(0, 1)}
    </div>
  );
}
