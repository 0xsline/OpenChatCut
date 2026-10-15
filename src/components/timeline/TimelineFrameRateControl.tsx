import { formatFrameRate, TIMELINE_FPS_OPTIONS } from '../../editor/timelineFrameRate';
import { useT } from '../../i18n/locale';

interface TimelineFrameRateControlProps {
  fps: number;
  /** Why the rate cannot change right now (an i18n key), or null when it can. */
  lock: string | null;
  onChange: (fps: number) => void;
}

/**
 * Project frame rate beside the aspect-ratio picker. Only rates every export
 * route renders without retiming are offered; a rate set elsewhere (MCP
 * create_project) is still shown, as the current value, but cannot be picked.
 */
export function TimelineFrameRateControlView({ fps, lock, onChange, translate }: TimelineFrameRateControlProps & {
  translate: (zh: string) => string;
}) {
  const label = `${formatFrameRate(fps)} fps`;
  return (
    <label className={`cc-aspect-select cc-fps-select cc-tip cc-tip-r${lock ? ' is-locked' : ''}`}
      data-tip={lock ? translate(lock) : translate('时间线帧率')}>
      <span aria-hidden="true">{label}</span>
      <select aria-label={translate('时间线帧率')} value={String(fps)} disabled={!!lock}
        onChange={(event) => onChange(Number(event.target.value))}>
        {!TIMELINE_FPS_OPTIONS.includes(fps) && <option value={String(fps)} disabled>{label}</option>}
        {TIMELINE_FPS_OPTIONS.map((option) => <option key={option} value={String(option)}>{option} fps</option>)}
      </select>
    </label>
  );
}

export function TimelineFrameRateControl(props: TimelineFrameRateControlProps) {
  return <TimelineFrameRateControlView {...props} translate={useT()} />;
}
