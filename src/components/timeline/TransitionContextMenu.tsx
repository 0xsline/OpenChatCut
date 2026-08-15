import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '../icons';
import { useT } from '../../i18n/locale';
import {
  TRANSITION_DURATION_PRESETS,
  activeTransitionPreset,
  transitionPresetFrames,
} from './transitionDuration';

interface TransitionContextMenuProps {
  label: string;
  durationInFrames: number;
  fps: number;
  locked: boolean;
  x: number;
  y: number;
  onSetDuration: (frames: number) => void;
  onRemove: () => void;
  onClose: () => void;
}

function MenuItem({ label, icon, checked, disabled, danger, onClick }: {
  label: string;
  icon: IconName;
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`cc-caption-cue-menu-item${danger ? ' danger' : ''}`}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="cc-caption-cue-menu-icon" aria-hidden><Icon name={icon} size={15} /></span>
      <span className="cc-caption-cue-menu-label">{label}</span>
      {checked && <span className="cc-track-context-menu-check" aria-hidden><Icon name="check" size={13} /></span>}
    </button>
  );
}

const Separator = () => <div className="cc-caption-cue-menu-separator" role="separator" />;

/** Right-click menu on a transition badge. Until now the badge only selected the
 *  incoming clip, so removing a transition meant finding it in the neighbouring
 *  clip's applied-effects list, and its duration could not be changed at all
 *  even though the model carries one. */
export function TransitionContextMenu({
  label, durationInFrames, fps, locked, x, y, onSetDuration, onRemove, onClose,
}: TransitionContextMenuProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const run = (action: () => void) => () => { action(); onClose(); };
  const active = activeTransitionPreset(durationInFrames, fps);

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
    });
  }, [x, y]);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="cc-caption-cue-menu cc-track-context-menu"
      role="menu"
      aria-label={t('转场菜单')}
      style={{ left: pos.left, top: pos.top }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="cc-transition-menu-title">{label}</div>
      <Separator />
      {TRANSITION_DURATION_PRESETS.map((seconds) => (
        <MenuItem
          key={seconds}
          label={t('{n} 秒', { n: seconds })}
          icon="clock"
          checked={active === seconds}
          disabled={locked}
          onClick={run(() => onSetDuration(transitionPresetFrames(seconds, fps)))}
        />
      ))}
      <Separator />
      <MenuItem label={t('删除转场')} icon="trash" danger disabled={locked} onClick={run(onRemove)} />
    </div>
  );
}
