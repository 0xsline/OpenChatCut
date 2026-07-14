import { theme } from '../theme';
import type { CaptionsData, CaptionPacing, CaptionTemplate } from '../captions/types';
import { CAPTION_STYLES } from '../captions/styles';

interface CaptionsControlsProps {
  captions: CaptionsData | null;
  hasTranscript: boolean;
  onGenerate: () => void; // (re)build captions from the current transcript
  onUpdate: (patch: Partial<CaptionsData>) => void;
  onTranslate: (lang: string) => void; // build a translated 2nd line (async, LLM)
  translating: boolean;
  translateError: string | null;
}

const PACINGS: { v: CaptionPacing; label: string }[] = [{ v: 'phrase', label: '短语' }, { v: 'word', label: '逐词' }];
const LANGS = ['中文', 'English', '日本語', 'Español', 'Français'];

// 字幕 overlay controls — live in the 文字稿 panel (captions derive from transcript).
export function CaptionsControls({ captions, hasTranscript, onGenerate, onUpdate, onTranslate, translating, translateError }: CaptionsControlsProps) {
  const lang = captions?.translationLang ?? '中文';
  return (
    <div style={{ borderTop: `1px solid ${theme.border}`, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: theme.text }}>字幕 overlay</div>
      {!captions ? (
        <>
          <button onClick={onGenerate} disabled={!hasTranscript} style={{ ...btn, background: theme.accent, color: '#fff', opacity: hasTranscript ? 1 : 0.5 }}>
            生成字幕
          </button>
          {!hasTranscript && (
            <div style={{ fontSize: 11, color: theme.textDim, lineHeight: 1.45 }}>
              先在上方「转写」该轨口播，再生成与时间线同步的字幕 overlay。
            </div>
          )}
        </>
      ) : (
        <>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: theme.text }}>
            <input type="checkbox" checked={captions.enabled} onChange={(e) => onUpdate({ enabled: e.target.checked })} />
            在预览/导出中显示字幕
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <select value={captions.template} onChange={(e) => onUpdate({ template: e.target.value as CaptionTemplate })} style={sel}>
              {CAPTION_STYLES.map((style) => <option key={style.id} value={style.id}>{style.label}</option>)}
            </select>
            <select value={captions.pacing} onChange={(e) => onUpdate({ pacing: e.target.value as CaptionPacing })} style={sel}>
              {PACINGS.map((p) => <option key={p.v} value={p.v}>{p.label}</option>)}
            </select>
          </div>
          <button onClick={onGenerate} disabled={!hasTranscript} style={{ ...btn, opacity: hasTranscript ? 1 : 0.5 }}>用当前文字稿重新生成</button>

          {/* 双语字幕:翻译成第二语言,作为第二行显示 */}
          <div style={{ borderTop: `1px dashed ${theme.border}`, paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 11.5, color: theme.textDim }}>双语字幕(翻译第二行)</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <select value={lang} onChange={(e) => onTranslate(e.target.value)} disabled={translating} style={sel}>
                {LANGS.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
              <button onClick={() => onTranslate(lang)} disabled={translating} style={{ ...btn, background: theme.accent, color: '#fff', opacity: translating ? 0.6 : 1, whiteSpace: 'nowrap' }}>
                {translating ? '翻译中…' : (captions.translation ? '重新翻译' : `翻译成 ${lang}`)}
              </button>
            </div>
            {captions.translation && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: theme.text }}>
                <input type="checkbox" checked={!!captions.bilingual} onChange={(e) => onUpdate({ bilingual: e.target.checked })} />
                显示双语第二行({captions.translationLang})
              </label>
            )}
            {translateError && <div style={{ fontSize: 11, color: '#f88' }}>{translateError}</div>}
          </div>
        </>
      )}
    </div>
  );
}

const btn: React.CSSProperties = { border: `1px solid ${theme.border}`, background: theme.panelAlt, color: theme.text, borderRadius: 6, padding: '7px 10px', fontSize: 12, cursor: 'pointer' };
const sel: React.CSSProperties = { flex: 1, background: theme.panelAlt, color: theme.text, border: `1px solid ${theme.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 12 };
