import { useEffect, useMemo, useState } from 'react';
import type { TimelineItem } from '../editor/types';
import { useT } from '../i18n/locale';
import type { TranscriptWord } from '../transcript/types';
import {
  appendManualCue, appendManualLane, isManualCaptionEntry,
  removeManualCue, removeManualLane, updateManualCue,
} from './manualCaptions';
import type { CaptionsData, CaptionSourceEntry } from './types';

interface Props {
  captions: CaptionsData;
  items: TimelineItem[];
  onUpdate: (patch: Partial<CaptionsData>) => void;
  getPlayheadMs?: () => number;
  onSeekMs?: (ms: number) => void;
}

const fieldStyle: React.CSSProperties = {
  background: 'var(--cc-bg)', color: 'var(--cc-text)', border: '1px solid var(--cc-border)',
  borderRadius: 6, padding: '5px 7px', font: 'inherit', fontSize: 12,
};

export function ManualCaptionEditor({ captions, items, onUpdate, getPlayheadMs, onSeekMs }: Props) {
  const t = useT();
  const lanes = useMemo(() => captions.sourceEntries?.filter(isManualCaptionEntry) ?? [], [captions.sourceEntries]);
  const [open, setOpen] = useState(lanes.length > 0);
  const [laneId, setLaneId] = useState(lanes[0]?.id ?? '');
  useEffect(() => {
    if (!lanes.some((lane) => lane.id === laneId)) setLaneId(lanes[0]?.id ?? '');
  }, [lanes, laneId]);
  const addLane = () => {
    const patch = appendManualLane(captions, items);
    const lane = patch.sourceEntries?.filter(isManualCaptionEntry).at(-1);
    onUpdate(patch);
    if (lane) setLaneId(lane.id);
    setOpen(true);
  };
  const lane = lanes.find((candidate) => candidate.id === laneId) ?? lanes[0];
  return (
    <div className="cc-cap-bilingual">
      <button type="button" className="cc-cap-bilingual-toggle" onClick={() => setOpen((value) => !value)}>
        <span>{t('手动字幕')}{lanes.length ? t('（{n} 车道）', { n: lanes.length }) : ''}</span>
        <span className="cc-cap-hint">{open ? t('收起') : t('展开')}</span>
      </button>
      {open && <ManualLanePanel {...{ captions, lanes, lane, laneId, setLaneId, addLane, onUpdate, getPlayheadMs, onSeekMs }} />}
    </div>
  );
}

interface LanePanelProps extends Omit<Props, 'items'> {
  lanes: CaptionSourceEntry[];
  lane?: CaptionSourceEntry;
  laneId: string;
  setLaneId: (id: string) => void;
  addLane: () => void;
}

function ManualLanePanel(props: LanePanelProps) {
  const { captions, lanes, lane, laneId, setLaneId, addLane, onUpdate, getPlayheadMs, onSeekMs } = props;
  const t = useT();
  return (
    <div className="cc-cap-bilingual-body">
      <div style={{ display: 'flex', gap: 6 }}>
        {lanes.length > 0 && <select className="cc-cap-select" value={laneId} onChange={(event) => setLaneId(event.target.value)}>
          {lanes.map((entry) => <option key={entry.id} value={entry.id}>{entry.label ?? t('手动字幕车道')}</option>)}
        </select>}
        <button type="button" className="cc-cap-btn sm" onClick={addLane}>{t('新建车道')}</button>
        {lane && <button type="button" className="cc-cap-btn sm ghost" onClick={() => onUpdate(removeManualLane(captions, lane.id))}>{t('删除车道')}</button>}
      </div>
      {!lane && <p className="cc-cap-hint">{t('新建手动字幕车道后，可在播放头位置添加字幕，不需要先转写或调用 AI。')}</p>}
      {lane && <ManualCueList key={lane.id} {...{ captions, lane, onUpdate, getPlayheadMs, onSeekMs }} />}
    </div>
  );
}

function ManualCueList({ captions, lane, onUpdate, getPlayheadMs, onSeekMs }: Omit<Props, 'items'> & { lane: CaptionSourceEntry }) {
  const t = useT();
  const [text, setText] = useState('');
  const [start, setStart] = useState(() => ((getPlayheadMs?.() ?? 0) / 1000).toFixed(1));
  const [duration, setDuration] = useState('3.0');
  const add = () => {
    const startMs = Number(start) * 1000;
    const patch = appendManualCue(captions, lane.id, text, startMs, startMs + Number(duration) * 1000);
    if (!patch) return;
    onUpdate(patch);
    setText('');
  };
  const syncPlayhead = () => setStart(((getPlayheadMs?.() ?? 0) / 1000).toFixed(1));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      <textarea rows={2} value={text} onChange={(event) => setText(event.target.value)} placeholder={t('输入字幕文字')} style={{ ...fieldStyle, resize: 'vertical' }} />
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <label className="cc-cap-hint">{t('开始')} <input type="number" min="0" step="0.1" value={start} onChange={(event) => setStart(event.target.value)} style={{ ...fieldStyle, width: 68 }} />s</label>
        <label className="cc-cap-hint">{t('时长')} <input type="number" min="0.1" step="0.1" value={duration} onChange={(event) => setDuration(event.target.value)} style={{ ...fieldStyle, width: 62 }} />s</label>
        <button type="button" className="cc-cap-btn sm" onClick={syncPlayhead}>{t('取播放头')}</button>
        <button type="button" className="cc-cap-btn primary sm" disabled={!text.trim()} onClick={add}>{t('添加字幕')}</button>
      </div>
      {(lane.words ?? []).map((cue, index) => <ManualCueRow key={`${lane.id}_${cue.start}_${cue.end}_${index}`} {...{ captions, lane, cue, index, onUpdate, onSeekMs }} />)}
    </div>
  );
}

function ManualCueRow({ captions, lane, cue, index, onUpdate, onSeekMs }: Omit<Props, 'items' | 'getPlayheadMs'> & { lane: CaptionSourceEntry; cue: TranscriptWord; index: number }) {
  const t = useT();
  const [text, setText] = useState(cue.text);
  const [start, setStart] = useState((cue.start / 1000).toFixed(1));
  const [end, setEnd] = useState((cue.end / 1000).toFixed(1));
  const save = () => {
    const patch = updateManualCue(captions, lane.id, index, text, Number(start) * 1000, Number(end) * 1000);
    if (patch) onUpdate(patch);
  };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '68px 68px 1fr auto', gap: 5, alignItems: 'center' }}>
      <input aria-label={t('开始秒数')} type="number" min="0" step="0.1" value={start} onChange={(event) => setStart(event.target.value)} onClick={() => onSeekMs?.(cue.start)} style={fieldStyle} />
      <input aria-label={t('结束秒数')} type="number" min="0.1" step="0.1" value={end} onChange={(event) => setEnd(event.target.value)} style={fieldStyle} />
      <input aria-label={t('字幕文字')} value={text} onChange={(event) => setText(event.target.value)} style={fieldStyle} />
      <div style={{ display: 'flex', gap: 4 }}>
        <button type="button" className="cc-cap-btn sm" onClick={save}>{t('保存')}</button>
        <button type="button" className="cc-cap-btn sm ghost" onClick={() => onUpdate(removeManualCue(captions, lane.id, index))}>{t('删除')}</button>
      </div>
    </div>
  );
}
