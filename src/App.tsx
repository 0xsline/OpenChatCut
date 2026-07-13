import { useMemo, useState } from 'react';
import { Player } from '@remotion/player';
import { MotionGraphic } from './MotionGraphic';
import templatesJson from './chatcut-templates.json';

type Tpl = {
  id: string;
  name: string;
  category: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  props: Record<string, unknown>;
  propSchema: { key: string; type: string; defaultValue: unknown }[];
  code: string;
};

const TEMPLATES = templatesJson as Tpl[];

export default function App() {
  const [idx, setIdx] = useState(0);
  const [props, setProps] = useState<Record<string, unknown>>(TEMPLATES[0].props);
  const t = TEMPLATES[idx];

  const item = useMemo(
    () => ({ props, width: t.width, height: t.height }),
    [props, t.width, t.height],
  );

  const pick = (i: number) => {
    setIdx(i);
    setProps(TEMPLATES[i].props);
  };

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'system-ui, sans-serif', color: '#eee', background: '#141414' }}>
      {/* sidebar: template list (= the ChatCut library) */}
      <aside style={{ width: 300, borderRight: '1px solid #2a2a2a', overflowY: 'auto', padding: 12 }}>
        <h2 style={{ fontSize: 15, margin: '4px 8px 12px' }}>ChatCut 模板 · Remotion 预览 seam</h2>
        {TEMPLATES.map((tp, i) => (
          <button
            key={tp.id}
            onClick={() => pick(i)}
            style={{
              display: 'block', width: '100%', textAlign: 'left', marginBottom: 6,
              padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
              border: '1px solid ' + (i === idx ? '#4a9eff' : '#2a2a2a'),
              background: i === idx ? '#12233a' : '#1c1c1c', color: '#eee',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600 }}>{tp.name}</div>
            <div style={{ fontSize: 11, opacity: 0.6 }}>{tp.category} · {tp.propSchema.length} props</div>
          </button>
        ))}
      </aside>

      {/* center: the Remotion Player rendering the selected ChatCut template */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <header style={{ padding: '12px 16px', borderBottom: '1px solid #2a2a2a' }}>
          <strong>{t.name}</strong>
          <span style={{ opacity: 0.5, marginLeft: 10, fontSize: 12 }}>
            {t.width}×{t.height} · {t.durationInFrames}f @ {t.fps}fps · Remotion Player
          </span>
        </header>
        <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 24, minHeight: 0 }}>
          <Player
            key={t.id}
            component={MotionGraphic}
            inputProps={{ code: t.code, item }}
            durationInFrames={t.durationInFrames}
            fps={t.fps}
            compositionWidth={t.width}
            compositionHeight={t.height}
            style={{ width: '100%', maxWidth: 960, aspectRatio: `${t.width} / ${t.height}`, border: '1px solid #2a2a2a', borderRadius: 8 }}
            controls
            loop
            autoPlay
          />
        </div>
      </main>

      {/* right: editable props (= the ChatCut property inspector) */}
      <aside style={{ width: 280, borderLeft: '1px solid #2a2a2a', overflowY: 'auto', padding: 14 }}>
        <h3 style={{ fontSize: 13, marginTop: 0 }}>属性 (meta.json)</h3>
        {t.propSchema.length === 0 && <p style={{ fontSize: 12, opacity: 0.6 }}>该模板用内置默认值(无可编辑属性)。</p>}
        {t.propSchema.map((p) => (
          <label key={p.key} style={{ display: 'block', marginBottom: 12, fontSize: 12 }}>
            <div style={{ opacity: 0.7, marginBottom: 4 }}>{p.key} <em style={{ opacity: 0.5 }}>({p.type})</em></div>
            {p.type === 'boolean' ? (
              <input
                type="checkbox"
                checked={!!props[p.key]}
                onChange={(e) => setProps((s) => ({ ...s, [p.key]: e.target.checked }))}
              />
            ) : p.type === 'color' ? (
              <input
                type="color"
                value={String(props[p.key] ?? '#000000')}
                onChange={(e) => setProps((s) => ({ ...s, [p.key]: e.target.value }))}
              />
            ) : (
              <input
                type={p.type === 'number' ? 'number' : 'text'}
                value={String(props[p.key] ?? '')}
                onChange={(e) =>
                  setProps((s) => ({ ...s, [p.key]: p.type === 'number' ? Number(e.target.value) : e.target.value }))
                }
                style={{ width: '100%', padding: '6px 8px', background: '#1c1c1c', color: '#eee', border: '1px solid #333', borderRadius: 6 }}
              />
            )}
          </label>
        ))}
      </aside>
    </div>
  );
}
