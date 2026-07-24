import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AudioAsset } from '../audio/library';
import {
  SOUND_EFFECTS,
  SOUND_GROUP_TONE,
  SOUND_GROUPS,
  formatSoundDuration,
  peaksToPath,
  resamplePeaks,
  soundEffectSrc,
  type SoundEffect,
} from '../audio/soundLibrary';
import { Icon } from '../components/icons';
import { useT } from '../i18n/locale';
import { setLibraryDrag } from './drag';

// Sound-library tab:
//   search ("Search sounds") + chips [popular, …groups] + list rows:
//   [group-color glyph / play] [name] [waveform] [duration] [+ add]

const POPULAR = '__popular__';
const WAVE_W = 100;
const WAVE_H = 32;
const WAVE_BINS = 48;

interface SoundBrowserProps {
  fps: number;
  onAdd: (asset: AudioAsset) => void;
}

function matchesQuery(s: SoundEffect, q: string): boolean {
  if (!q) return true;
  const tokens = q
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .split(/[^\p{Letter}\p{Number}]+/u)
    .filter(Boolean);
  if (!tokens.length) return true;
  const hay = [
    s.name,
    s.desc,
    s.group,
    ...s.keywords,
    SOUND_GROUPS.find((g) => g.id === s.group)?.name ?? '',
    SOUND_GROUPS.find((g) => g.id === s.group)?.nameEn ?? '',
  ]
    .join(' ')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

function toAsset(s: SoundEffect, fps: number): AudioAsset {
  return {
    id: `sfx_${s.id}`,
    name: s.name,
    category: 'sfx',
    src: soundEffectSrc(s.id),
    durationInFrames: Math.max(1, Math.round(s.seconds * fps)),
  };
}

export const SoundBrowser = memo(function SoundBrowser({ fps, onAdd }: SoundBrowserProps) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [chip, setChip] = useState<string>(POPULAR);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef(0);

  const stopAudition = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.removeAttribute('src');
      a.load();
    }
    audioRef.current = null;
    setPlayingId(null);
    setProgress(0);
  }, []);

  useEffect(() => () => stopAudition(), [stopAudition]);

  const tick = useCallback(() => {
    const a = audioRef.current;
    if (!a || a.paused || !a.duration) return;
    setProgress(a.currentTime / a.duration);
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const audition = useCallback(
    (s: SoundEffect) => {
      if (playingId === s.id) {
        stopAudition();
        return;
      }
      stopAudition();
      const a = new Audio(soundEffectSrc(s.id));
      a.preload = 'auto';
      audioRef.current = a;
      setPlayingId(s.id);
      setProgress(0);
      a.onended = () => stopAudition();
      a.onerror = () => stopAudition();
      void a.play().then(() => {
        rafRef.current = requestAnimationFrame(tick);
      }).catch(() => stopAudition());
    },
    [playingId, stopAudition, tick],
  );

  const list = useMemo(() => {
    const q = query.trim();
    let base = SOUND_EFFECTS.filter((s) => matchesQuery(s, q));
    if (chip === POPULAR) base = base.filter((s) => s.popular);
    else base = base.filter((s) => s.group === chip);
    return [...base].sort((a, b) => a.order - b.order);
  }, [chip, query]);

  return (
    <div className="cc-sound-browser">
      <label className="cc-sound-search" htmlFor="cc-sound-library-search">
        <Icon name="search" size={13} />
        <input
          id="cc-sound-library-search"
          type="search"
          placeholder={t('Search for sound effects')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        {query ? (
          <button type="button" className="cc-sound-search-clear" onClick={() => setQuery('')} aria-label={t('Clear')}>
            <Icon name="x" size={12} />
          </button>
        ) : null}
      </label>

      <div className="cc-sound-chips" role="tablist" aria-label={t('Sound effects grouping')}>
        <button
          type="button"
          role="tab"
          aria-selected={chip === POPULAR}
          className={`cc-sound-chip${chip === POPULAR ? ' selected' : ''}`}
          onClick={() => setChip(POPULAR)}
        >
          {t('Popular')}
        </button>
        {SOUND_GROUPS.map((g) => (
          <button
            key={g.id}
            type="button"
            role="tab"
            aria-selected={chip === g.id}
            className={`cc-sound-chip${chip === g.id ? ' selected' : ''}`}
            onClick={() => setChip(g.id)}
          >
            {g.name}
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <div className="cc-sound-empty">{t('There are currently no sound effects in this category')}{query ? t('(with "{query}” does not match)', { query }) : ''}</div>
      ) : (
        <div className="cc-sound-list" role="listbox" aria-label={t('Sound effects list')}>
          {list.map((s) => {
            const tone = SOUND_GROUP_TONE[s.group] ?? SOUND_GROUP_TONE['ui-motion-feedback']!;
            const isPlaying = playingId === s.id;
            const bins = resamplePeaks(s.peaks, WAVE_BINS);
            const path = peaksToPath(bins, WAVE_W, WAVE_H);
            const clipId = `cc-sfx-clip-${s.id}`;
            return (
              <div
                key={s.id}
                role="option"
                aria-selected={isPlaying}
                className={`cc-sound-row${isPlaying ? ' active' : ''}`}
                title={t('{desc} · Can be dragged to the timeline audio track', { desc: s.desc })}
                draggable
                onDragStart={(e) => {
                  setLibraryDrag(e, {
                    kind: 'sound',
                    id: s.id,
                    name: s.name,
                    src: soundEffectSrc(s.id),
                    seconds: s.seconds,
                  });
                }}
                onClick={() => audition(s)}
                onDoubleClick={() => onAdd(toAsset(s, fps))}
              >
                <button
                  type="button"
                  className="cc-sound-glyph"
                  style={{ backgroundColor: tone.bg, color: tone.ink }}
                  onClick={(e) => {
                    e.stopPropagation();
                    audition(s);
                  }}
                  aria-label={isPlaying ? t('pause {name}', { name: s.name }) : t('audition {name}', { name: s.name })}
                >
                  <Icon name={isPlaying ? 'pause' : 'play'} size={12} />
                </button>

                <div className="cc-sound-meta">
                  <div className="cc-sound-name">{s.name}</div>
                </div>

                <div className="cc-sound-wave" aria-hidden>
                  <svg viewBox={`0 0 ${WAVE_W} ${WAVE_H}`} preserveAspectRatio="none">
                    <path d={path} className="cc-sound-wave-base" />
                    <clipPath id={clipId}>
                      <rect x={0} y={0} width={(isPlaying ? progress : 0) * WAVE_W} height={WAVE_H} />
                    </clipPath>
                    <path d={path} className="cc-sound-wave-prog" clipPath={`url(#${clipId})`} style={{ fill: tone.glyph }} />
                  </svg>
                </div>

                <span className="cc-sound-dur">{formatSoundDuration(s.seconds)}</span>

                <button
                  type="button"
                  className="cc-sound-add"
                  title={t('Add to timeline:{name}', { name: s.name })}
                  aria-label={t('add {name}', { name: s.name })}
                  onClick={(e) => {
                    e.stopPropagation();
                    onAdd(toAsset(s, fps));
                  }}
                >
                  <Icon name="plus" size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="cc-sound-hint">{t('Click to listen · Double click/point + Or drag to the timeline audio track · total {n} sound effects', { n: SOUND_EFFECTS.length })}</div>
    </div>
  );
});
