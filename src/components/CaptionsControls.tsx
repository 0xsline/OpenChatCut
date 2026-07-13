import { theme } from '../theme';
import type { CaptionsData, CaptionTemplate, CaptionPacing } from '../captions/types';

interface CaptionsControlsProps {
  captions: CaptionsData | null;
  hasTranscript: boolean;
  onGenerate: () => void; // (re)build captions from the current transcript
  onUpdate: (patch: Partial<CaptionsData>) => void;
}

const TEMPLATES: CaptionTemplate[] = ['tiktok', 'netflix', 'plain'];
const PACINGS: { v: CaptionPacing; label: string }[] = [{ v: 'phrase', label: '短语' }, { v: 'word', label: '逐词' }];

// 字幕 overlay controls — live in the 文字稿 panel (captions derive from transcript).
export function CaptionsControls({ captions, hasTranscript, onGenerate, onUpdate }: CaptionsControlsProps) {
  return (
    <div style={{ borderTop: `1px solid ${theme.border}`, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: theme.text }}>字幕 overlay</div>
      {!captions ? (
        <button onClick={onGenerate} disabled={!hasTranscript} style={{ ...btn, background: theme.accent, color: '#fff', opacity: hasTranscript ? 1 : 0.5 }}>
          生成字幕
        </button>
      ) : (
        <>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: theme.text }}>
            <input type="checkbox" checked={captions.enabled} onChange={(e) => onUpdate({ enabled: e.target.checked })} />
            在预览/导出中显示字幕
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <select value={captions.template} onChange={(e) => onUpdate({ template: e.target.value as CaptionTemplate })} style={sel}>
              {TEMPLATES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select value={captions.pacing} onChange={(e) => onUpdate({ pacing: e.target.value as CaptionPacing })} style={sel}>
              {PACINGS.map((p) => <option key={p.v} value={p.v}>{p.label}</option>)}
            </select>
          </div>
          <button onClick={onGenerate} disabled={!hasTranscript} style={{ ...btn, opacity: hasTranscript ? 1 : 0.5 }}>用当前文字稿重新生成</button>
        </>
      )}
    </div>
  );
}

const btn: React.CSSProperties = { border: `1px solid ${theme.border}`, background: theme.panelAlt, color: theme.text, borderRadius: 6, padding: '7px 10px', fontSize: 12, cursor: 'pointer' };
const sel: React.CSSProperties = { flex: 1, background: theme.panelAlt, color: theme.text, border: `1px solid ${theme.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 12 };
