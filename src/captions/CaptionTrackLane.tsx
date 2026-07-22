import { captionPages } from './exportCaptions';
import type { TimelineState } from '../editor/types';
import { theme, themeAlpha } from '../theme';
import { useT } from '../i18n/locale';

function cueText(words: Array<{ text: string }>): string {
  return words.map((word) => word.text.trim()).filter(Boolean).join(' ');
}

export function CaptionTrackLane({ state, px, hidden, locked }: {
  state: TimelineState;
  px: number;
  hidden: boolean;
  locked: boolean;
}) {
  const t = useT();
  const pages = state.captions ? captionPages(state.captions, state.items, state.fps) : [];
  return (
    <div className="cc-caption-track-lane" style={{
      background: locked ? `color-mix(in srgb, ${theme.bg} 70%, ${themeAlpha.shadow(1)})` : theme.bg,
      opacity: hidden ? 0.4 : locked ? 0.75 : 1,
    }}>
      {!pages.length && <span className="cc-caption-track-empty">{t('字幕轨道为空')}</span>}
      {pages.map((page, index) => {
        const startFrame = Math.max(0, Math.round(page.start * state.fps / 1000));
        const durationFrames = Math.max(2, Math.round((page.end - page.start) * state.fps / 1000));
        const text = cueText(page.words);
        return (
          <div key={`${startFrame}:${index}`} className="cc-caption-track-cue" title={text} style={{
            left: startFrame * px,
            width: Math.max(18, durationFrames * px),
          }}>{text}</div>
        );
      })}
    </div>
  );
}
