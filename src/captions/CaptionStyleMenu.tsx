// 轨道头「字幕样式与翻译」弹层:内置样式列表 + 用户预设(存/用/删)+ 保存命名 +
// 翻译子菜单。字幕域组件——Timeline 只管单开互斥与定位(captionMenu 状态/外点关闭),
// 动作与预设/命名/忙碌状态都在这里。命名走内联输入,不用 window.prompt(Electron 不支持)。
// 错误行例外:也被菜单外的「开启字幕」按钮写(该轨无文字稿),故由 Timeline 持有传入。
import { useEffect, useState } from 'react';
import { CAPTION_STYLES } from './styles';
import { buildTranslation } from './translate';
import type { CaptionsData, CaptionTemplate } from './types';
import { deleteCaptionPreset, listCaptionPresets, saveCaptionPreset, type CaptionPreset } from './presetStore';
import type { TimelineState, TrackId } from '../editor/types';
import type { EditorCommands } from '../editor/store';
import { useT } from '../i18n/locale';
import { ensureFont } from '../fonts/googleFonts';
import { captionsForTrack } from './captionTrack';
import { newManualCaptions } from './manualCaptions';

const CAPTION_LANGS = ['English', '日本語', '한국어', 'Español', 'Français', 'Deutsch', 'Português'];

interface CaptionStyleMenuProps {
  state: TimelineState;
  commands: EditorCommands;
  trackId: TrackId;
  pos: { left: number; top: number };
  error: string | null;
  onError: (msg: string | null) => void;
  onClose: () => void;
}

export function CaptionStyleMenu({ state, commands, trackId, pos, error, onError, onClose }: CaptionStyleMenuProps) {
  const t = useT();
  const [presets, setPresets] = useState<CaptionPreset[]>([]);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [translateOpen, setTranslateOpen] = useState(false);
  useEffect(() => {
    void listCaptionPresets().then(setPresets).catch(() => {});
  }, []);

  const applyStyle = (template: CaptionTemplate) => {
    const captions = captionsForTrack(state, trackId) ?? newManualCaptions();
    if (state.captions) commands.updateCaptions({ enabled: true, template });
    else commands.setCaptions({ ...captions, template });
    onError(null);
    onClose();
  };
  /** Save current captions look as a user preset (edit_captions preset_save). */
  const confirmSave = async (name: string) => {
    const captions = state.captions;
    if (!captions) { onError(t('请先启用字幕并选择样式')); return; }
    if (!name.trim()) return;
    try {
      const preset: CaptionPreset = {
        id: `cap_preset_${crypto.randomUUID()}`,
        name: name.trim(),
        template: captions.template,
        styleOverride: captions.styleOverride,
        pacing: captions.pacing,
        createdAt: Date.now(),
      };
      await saveCaptionPreset(preset);
      setPresets(await listCaptionPresets());
      onError(null);
      setNameDraft(null);
    } catch (e) {
      onError(e instanceof Error ? e.message : t('保存样式失败'));
    }
  };
  const removePreset = async (id: string) => {
    try {
      await deleteCaptionPreset(id);
      setPresets(await listCaptionPresets());
    } catch (e) {
      onError(e instanceof Error ? e.message : t('删除样式失败'));
    }
  };
  const applyPreset = (preset: CaptionPreset) => {
    const captions = captionsForTrack(state, trackId) ?? newManualCaptions();
    const patch: Partial<CaptionsData> = {
      enabled: true,
      ...(preset.template ? { template: preset.template } : {}),
      ...(preset.pacing ? { pacing: preset.pacing } : {}),
      ...(preset.styleOverride ? { styleOverride: preset.styleOverride } : {}),
    };
    if (state.captions) commands.updateCaptions(patch);
    else commands.setCaptions({ ...captions, ...patch });
    onError(null);
    onClose();
  };
  const translate = async (lang: string) => {
    if (busy) return;
    const captions = captionsForTrack(state, trackId);
    if (!captions) { onError(t('该轨道还没有可翻译的文字稿，请先完成转写')); return; }
    setBusy(true);
    onError(null);
    try {
      const translation = await buildTranslation(captions, state.items, state.fps, lang);
      const patch = { enabled: true, bilingual: true, translationLang: lang, translation };
      if (state.captions) commands.updateCaptions(patch);
      else commands.setCaptions({ ...captions, ...patch });
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : t('字幕翻译失败'));
    } finally { setBusy(false); }
  };

  return (
    <div className="cc-caption-style-menu" style={{ position: 'fixed', left: pos.left, top: pos.top }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="cc-caption-style-title">{t('样式')}</div>
      <div className="cc-caption-style-list">
        {CAPTION_STYLES.map((style) => {
          ensureFont(style.fontFamily);
          return (
            <button key={style.id} className={state.captions?.template === style.id ? 'active' : ''} onClick={() => applyStyle(style.id)}>
              <span className="cc-caption-style-swatch" style={{ background: style.highlightBackground ?? '#292929', color: style.highlightBackground ? style.highlightColor : style.color, fontFamily: style.fontFamily, WebkitTextStroke: style.strokeWidth ? `${Math.min(1, style.strokeWidth)}px ${style.strokeColor}` : undefined }}>Aa</span>
              <span>{t(style.labelZh)}</span>
            </button>
          );
        })}
        {presets.length > 0 && (
          <>
            <div className="cc-caption-style-title" style={{ marginTop: 4 }}>{t('我的样式')}</div>
            {presets.map((p) => (
              <button key={p.id} type="button" onClick={() => applyPreset(p)}>
                <span className="cc-caption-style-swatch" style={{ background: '#292929', color: '#fff' }}>★</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                <span
                  className="cc-caption-preset-del"
                  role="button"
                  title={t('删除此预设')}
                  onClick={(e) => { e.stopPropagation(); void removePreset(p.id); }}
                >✕</span>
              </button>
            ))}
          </>
        )}
      </div>
      {nameDraft !== null ? (
        <div className="cc-caption-preset-name-row">
          <input
            autoFocus
            value={nameDraft}
            placeholder={t('预设名称')}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void confirmSave(nameDraft);
              else if (e.key === 'Escape') setNameDraft(null);
            }}
          />
          <button type="button" onClick={() => void confirmSave(nameDraft)}>{t('保存')}</button>
          <button type="button" title={t('取消')} onClick={() => setNameDraft(null)}>✕</button>
        </div>
      ) : (
        <button
          type="button"
          className="cc-caption-style-save"
          disabled={!state.captions}
          title={state.captions ? t('把当前模板/覆盖样式保存为用户预设') : t('请先启用字幕')}
          onClick={() => setNameDraft(`我的样式 ${new Date().toLocaleDateString()}`)}
        >
          {t('＋ 保存当前样式...')}
        </button>
      )}
      <div className="cc-caption-translate-wrap">
        <button className="cc-caption-translate" disabled={busy} onClick={() => setTranslateOpen((open) => !open)}>
          <span>{t('文A')}</span><span>{busy ? t('翻译中...') : t('翻译字幕')}</span><span>›</span>
        </button>
        {translateOpen && (
          <div className="cc-caption-language-menu">
            {CAPTION_LANGS.map((lang) => <button key={lang} onClick={() => void translate(lang)}>{lang}</button>)}
          </div>
        )}
      </div>
      {error && <div className="cc-caption-style-error">{error}</div>}
    </div>
  );
}
