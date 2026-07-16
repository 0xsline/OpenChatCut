import { useState } from 'react';
import { theme } from '../theme';
import { SCENARIO_PRESETS, type ScenarioGroup, type ScenarioPreset } from '../generate/scenarioPresets';

// 「从场景开始」画廊(Dashboard 工程区下方):19 张预设卡,hover 播预览视频,
// 点击交给上层建工程并跳编辑器。分组徽标文案为自定中文(源站无据,原文只有
// scenarioId: video-gen / app-promo)。
const GROUP_LABEL: Record<ScenarioGroup, string> = { 'video-gen': '视频生成', 'app-promo': '应用推广' };

interface ScenarioGalleryProps {
  onPick: (preset: ScenarioPreset) => void;
}

export function ScenarioGallery({ onPick }: ScenarioGalleryProps) {
  const [hoverId, setHoverId] = useState<string | null>(null);

  return (
    <section style={{ marginTop: 40 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em' }}>从场景开始</h2>
        <span style={{ color: theme.textDim, fontSize: 12 }}>选一个场景,AI 按预设提示词起步</span>
      </div>
      <div style={grid}>
        {SCENARIO_PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => onPick(p)}
            onMouseEnter={() => setHoverId(p.id)}
            onMouseLeave={() => setHoverId((id) => (id === p.id ? null : id))}
            style={card}
            title={`${p.name} · 用此场景新建工程`}
          >
            <div style={coverBox}>
              <img src={p.coverUrl} alt={p.nameZh} loading="lazy" style={coverMedia} />
              {hoverId === p.id && (
                // 悬停才挂载视频(muted loop 自动播),移开即卸载回封面。预览 mp4 是
                // local-only(gitignore),缺失时 onError 隐藏自身优雅回落到封面图。
                <video src={p.previewUrl} autoPlay muted loop playsInline
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  style={{ ...coverMedia, position: 'absolute', inset: 0 }} />
              )}
            </div>
            <div style={{ padding: '8px 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={nameStyle}>{p.nameZh}</span>
              <span style={badge}>{GROUP_LABEL[p.group]}</span>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(196px, 1fr))', gap: 14 };
const card: React.CSSProperties = {
  padding: 0, textAlign: 'left', border: `1px solid ${theme.border}`, borderRadius: 10,
  background: theme.panel, overflow: 'hidden', cursor: 'pointer', color: theme.text, font: 'inherit',
};
const coverBox: React.CSSProperties = {
  position: 'relative', width: '100%', aspectRatio: '16 / 9', background: theme.bg,
  borderBottom: `1px solid ${theme.border}`, overflow: 'hidden',
};
const coverMedia: React.CSSProperties = { width: '100%', height: '100%', objectFit: 'cover', display: 'block' };
const nameStyle: React.CSSProperties = {
  fontSize: 12.5, fontWeight: 550, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
};
const badge: React.CSSProperties = {
  flexShrink: 0, fontSize: 10, color: theme.textDim, border: `1px solid ${theme.border}`,
  borderRadius: 999, padding: '1px 7px', lineHeight: '14px',
};
