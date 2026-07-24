// Track header "Subtitle Style and Translation" pop-up layer: built-in style list + user default (save/use/delete) + save name +
// Translate submenu. Subtitle domain component - Timeline only supports single-open mutual exclusion and positioning (captionMenu status/outside point closed),
// Actions and presets/names/busy states are all here. The name is input inline, without window.prompt (Electron does not support it).
// Exception for the error line: it is also written by the "Turn on subtitles" button outside the menu (there is no text script for this track), so it is passed in by Timeline.
import { useEffect, useState } from 'react';
import { CAPTION_STYLES } from './styles';
import { buildTranslation } from './translate';
import type { CaptionsData, CaptionTemplate } from './types';
import { deleteCaptionPreset, listCaptionPresets, saveCaptionPreset, type CaptionPreset } from './presetStore';
import { captionsOnTrack, type TimelineState, type TrackId } from '../editor/types';
import type { EditorCommands } from '../editor/store';
import { useT } from '../i18n/locale';
import { ensureFont } from '../fonts/googleFonts';
import { captionsForTrack } from './captionTrack';
import { newManualCaptions } from './manualCaptions';

const CAPTION_LANGS = ['English', 'Japanese', '한국어', 'Español', 'Français', 'Deutsch', 'Português'];

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
  const current = captionsOnTrack(state, trackId);
  useEffect(() => {
    void listCaptionPresets().then(setPresets).catch(() => {});
  }, []);

  const applyStyle = (template: CaptionTemplate) => {
    const captions = captionsForTrack(state, trackId) ?? newManualCaptions();
    if (current) commands.updateCaptions({ enabled: true, template }, trackId);
    else commands.setCaptions({ ...captions, template }, trackId);
    onError(null);
    onClose();
  };
  /** Save current captions look as a user preset (edit_captions preset_save). */
  const confirmSave = async (name: string) => {
    const captions = current;
    if (!captions) { onError(t('Please enable subtitles and select a style first')); return; }
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
      onError(e instanceof Error ? e.message : t('Failed to save style'));
    }
  };
  const removePreset = async (id: string) => {
    try {
      await deleteCaptionPreset(id);
      setPresets(await listCaptionPresets());
    } catch (e) {
      onError(e instanceof Error ? e.message : t('Failed to delete style'));
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
    if (current) commands.updateCaptions(patch, trackId);
    else commands.setCaptions({ ...captions, ...patch }, trackId);
    onError(null);
    onClose();
  };
  const translate = async (lang: string) => {
    if (busy) return;
    const captions = captionsForTrack(state, trackId);
    if (!captions) { onError(t('There is no translatable transcript for this track yet, please complete the transcription first')); return; }
    setBusy(true);
    onError(null);
    try {
      const translation = await buildTranslation(captions, state.items, state.fps, lang);
      const patch = { enabled: true, bilingual: true, translationLang: lang, translation };
      if (current) commands.updateCaptions(patch, trackId);
      else commands.setCaptions({ ...captions, ...patch }, trackId);
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : t('Subtitle translation failed'));
    } finally { setBusy(false); }
  };

  return (
    <div className="cc-caption-style-menu" style={{ position: 'fixed', left: pos.left, top: pos.top }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="cc-caption-style-title">{t('style')}</div>
      <div className="cc-caption-style-list">
        {CAPTION_STYLES.map((style) => {
          ensureFont(style.fontFamily);
          return (
            <button type="button" key={style.id} className={current?.template === style.id ? 'active' : ''} onClick={() => applyStyle(style.id)}>
              <span className="cc-caption-style-swatch" style={{ background: style.highlightBackground ?? '#292929', color: style.highlightBackground ? style.highlightColor : style.color, fontFamily: style.fontFamily, WebkitTextStroke: style.strokeWidth ? `${Math.min(1, style.strokeWidth)}px ${style.strokeColor}` : undefined }}>Aa</span>
              <span>{t(style.labelZh)}</span>
            </button>
          );
        })}
        {presets.length > 0 && (
          <>
            <div className="cc-caption-style-title" style={{ marginTop: 4 }}>{t('my style')}</div>
            {presets.map((p) => (
              <button key={p.id} type="button" onClick={() => applyPreset(p)}>
                <span className="cc-caption-style-swatch" style={{ background: '#292929', color: '#fff' }}>★</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                <span
                  className="cc-caption-preset-del"
                  role="button"
                  title={t('Delete this preset')}
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
            placeholder={t('Default name')}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void confirmSave(nameDraft);
              else if (e.key === 'Escape') setNameDraft(null);
            }}
          />
          <button type="button" onClick={() => void confirmSave(nameDraft)}>{t('save')}</button>
          <button type="button" title={t('Cancel')} onClick={() => setNameDraft(null)}>✕</button>
        </div>
      ) : (
        <button
          type="button"
          className="cc-caption-style-save"
          disabled={!current}
          title={current ? t('Put the current template/Override styles saved as user presets') : t('Please enable subtitles first')}
          onClick={() => setNameDraft(`my style ${new Date().toLocaleDateString()}`)}
        >
          {t('+ Save current style...')}
        </button>
      )}
      <div className="cc-caption-translate-wrap">
        <button type="button" className="cc-caption-translate" disabled={busy} onClick={() => setTranslateOpen((open) => !open)} aria-expanded={translateOpen}>
          <span>{t('textA')}</span><span>{busy ? t('Translating...') : t('Translate subtitles')}</span><span>›</span>
        </button>
        {translateOpen && (
          <div className="cc-caption-language-menu">
            {CAPTION_LANGS.map((lang) => <button type="button" key={lang} onClick={() => void translate(lang)}>{lang}</button>)}
          </div>
        )}
      </div>
      {error && <div className="cc-caption-style-error">{error}</div>}
    </div>
  );
}
