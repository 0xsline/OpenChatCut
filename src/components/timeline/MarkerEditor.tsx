// 标记批注编辑弹窗(逐字搬自 Timeline.tsx):点标尺图钉打开——批注 textarea +
// 8 色圈 + 时长秒输入(0=点,>0=区间条)+ 删除/完成。编辑即写(updateMarker 直落),
// 「完成」只是关窗。
import { theme, themeAlpha } from '../../theme';
import { MARKER_HEX, type Marker, type MarkerColor } from '../../editor/types';
import type { EditorCommands } from '../../editor/store';
import { useT } from '../../i18n/locale';
import { fmt } from './timelineUtil';

const toolBtn: React.CSSProperties = { background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', fontSize: 14, padding: '2px 5px' };

interface MarkerEditorProps {
  editing: Marker;
  fps: number;
  commands: EditorCommands;
  onClose: () => void;
}

export function MarkerEditor({ editing, fps, commands, onClose }: MarkerEditorProps) {
  const t = useT();
  return (
    <div style={{ position: 'absolute', top: 40, left: 12, zIndex: 20, width: 260, background: theme.panelAlt, border: `0.5px solid ${theme.border}`, borderRadius: 5, padding: 12, boxShadow: `0 8px 28px ${themeAlpha.shadow(0.45)}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, fontSize: 12, color: theme.textDim }}>
        <svg width="12" height="14" viewBox="0 0 24 24" fill={MARKER_HEX[editing.color]}><path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" /></svg>
        {t('标记')} · {fmt(editing.fromFrame, fps)}
      </div>
      <textarea autoFocus value={editing.note} onChange={(e) => commands.updateMarker(editing.id, { note: e.target.value })} rows={3} placeholder={t('批注…')}
        style={{ width: '100%', resize: 'vertical', background: theme.bg, color: theme.text, border: `0.5px solid ${theme.borderLight}`, borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit' }} />
      <div style={{ display: 'flex', gap: 6, margin: '9px 0' }}>
        {(Object.keys(MARKER_HEX) as MarkerColor[]).map((c) => (
          <button key={c} onClick={() => commands.updateMarker(editing.id, { color: c })} title={c}
            style={{ width: 16, height: 16, borderRadius: '50%', background: MARKER_HEX[c], border: editing.color === c ? `2px solid ${theme.textStrong}` : '2px solid transparent', cursor: 'pointer', padding: 0 }} />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 9, fontSize: 12, color: theme.textDim }}>
        <span>{t('时长')}</span>
        <input type="number" min={0} step={0.1} value={+(editing.durationFrames / fps).toFixed(2)}
          onChange={(e) => commands.updateMarker(editing.id, { durationFrames: Math.max(0, Math.round(Number(e.target.value) * fps)) })}
          style={{ width: 56, background: theme.bg, color: theme.text, border: `0.5px solid ${theme.borderLight}`, borderRadius: 6, padding: '3px 6px', fontSize: 12 }} />
        <span>{t('秒')}{editing.durationFrames > 0 ? t('（区间）') : t('（点）')}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button onClick={() => { commands.removeMarker(editing.id); onClose(); }} style={{ ...toolBtn, color: theme.accent, fontSize: 12 }}>{t('删除')}</button>
        <span style={{ flex: 1 }} />
        <button onClick={onClose} style={{ background: theme.accent, border: 'none', borderRadius: 6, color: theme.onAccent, cursor: 'pointer', fontSize: 12, padding: '4px 12px' }}>{t('完成')}</button>
      </div>
    </div>
  );
}
