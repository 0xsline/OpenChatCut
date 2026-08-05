import type { TimelineState } from '../editor/types';
import { trackAlias } from '../editor/types';
import { useT } from '../i18n/locale';
import {
  MAX_VIDEO_BITRATE_MBPS,
  MIN_VIDEO_BITRATE_MBPS,
} from './bitrate';
import { ExportBitrateControl } from './ExportBitrateControl';
import { ExportQaCard, InfoCard, Row, Segmented } from './ExportDialogParts';
import {
  EXPORT_FPS,
  EXPORT_RESOLUTION_OPTIONS,
  type ExportSubtitleSettings,
  type ExportVideoSettings,
} from './useExportDialogModel';
import type { ExportQaUiState, ExportTab } from './useExportWorkflow';

const resolutionLabel = (value: string): string => value === '4k' ? '4K' : value;
const clampBitrate = (value: number): number => Math.max(
  MIN_VIDEO_BITRATE_MBPS,
  Math.min(MAX_VIDEO_BITRATE_MBPS, value),
);

interface VideoSettingsProps {
  video: ExportVideoSettings;
  busy: boolean;
  qualityMode: 'balanced' | 'master';
  setQualityMode: (mode: 'balanced' | 'master') => void;
}

function VideoSettings({ video, busy, qualityMode, setQualityMode }: VideoSettingsProps) {
  const t = useT();
  return (
    <>
      <Row label={t('画质策略')}>
        <Segmented
          options={[
            { value: 'balanced', label: t('均衡') },
            { value: 'master', label: t('画质优先') },
          ]}
          value={qualityMode}
          onChange={setQualityMode}
        />
      </Row>
      <p className="cc-export-footnote">
        {qualityMode === 'master'
          ? t('原片优先预览；导出默认高码率，不主动压缩导入素材。')
          : t('平衡流畅与体积；预览可使用代理，导出默认自动码率。')}
      </p>
      <Row label={t('格式 / 编码')}>
        <select
          className="cc-export-select"
          value={video.codec}
          onChange={(event) => video.setCodec(event.target.value as 'h264' | 'vp8' | 'prores')}
          disabled={busy}
        >
          <option value="h264">MP4 (H.264)</option>
          <option value="vp8">WebM (VP8)</option>
          <option value="prores">{t('ProRes 422 HQ 母带 (.mov)')}</option>
        </select>
      </Row>
      {video.codec === 'prores' && (
        <p className="cc-export-footnote">
          {t('ProRes 母带体积较大，仅本机渲染；适合调色或交给达芬奇继续剪。网发请用 H.264。')}
        </p>
      )}
      <Row label={t('分辨率')}>
        <Segmented options={EXPORT_RESOLUTION_OPTIONS.map((value) => ({ value, label: resolutionLabel(value) }))} value={video.resolution} onChange={video.setResolution} />
      </Row>
      <Row label={t('帧率')}>
        <Segmented options={EXPORT_FPS.map((value) => ({ value, label: `${value} fps` }))} value={video.fps} onChange={video.setFps} />
      </Row>
      {video.codec !== 'prores' && (
        <Row label={t('码率')}>
          <ExportBitrateControl
            mode={video.bitrateMode}
            customMbps={video.customBitrateMbps}
            resolvedBps={video.resolvedBitrate}
            disabled={busy}
            onModeChange={video.setBitrateMode}
            onCustomMbpsChange={(value) => video.setCustomBitrateMbps(clampBitrate(value))}
          />
        </Row>
      )}
    </>
  );
}

interface QaSettingsProps {
  enabled: boolean;
  busy: boolean;
  qa: ExportQaUiState | null;
  onToggle: (enabled: boolean) => void;
}

function QaSettings({ enabled, busy, qa, onToggle }: QaSettingsProps) {
  const t = useT();
  return (
    <>
      <label className="cc-export-toggle cc-export-qa-toggle">
        <span>
          <strong>{t('导出后自动质量检查')}</strong>
          <small>{t('检查画面、声音、剪辑点和字幕安全区；临时失败最多自动复检 3 轮。')}</small>
        </span>
        <input type="checkbox" checked={enabled} onChange={(event) => onToggle(event.target.checked)} disabled={busy} />
      </label>
      {qa && <ExportQaCard qa={qa} />}
    </>
  );
}

interface VideoTabProps extends VideoSettingsProps, QaSettingsProps {}

function VideoTab({ video, busy, qualityMode, setQualityMode, enabled, qa, onToggle }: VideoTabProps) {
  return (
    <>
      <VideoSettings video={video} busy={busy} qualityMode={qualityMode} setQualityMode={setQualityMode} />
      <QaSettings enabled={enabled} busy={busy} qa={qa} onToggle={onToggle} />
    </>
  );
}

function AudioTab() {
  const t = useT();
  return <InfoCard icon="music" title={t('MP3 音轨')} text={t('提取时间线中的完整混音，视频画面不会写入文件。')} />;
}

function MotionGraphicsTab({ count }: { count: number }) {
  const t = useT();
  return (
    <InfoCard
      icon="sparkles"
      title={count ? t('{n} 个动态图层', { n: count }) : t('没有可导出的动态图层')}
      text={count
        ? t('逐个生成带透明通道的 ProRes 4444 MOV，方便在其他工程中复用。')
        : t('先在时间线上添加 MG 动画，再从这里生成透明素材。')}
    />
  );
}

function SubtitlesTab({ state, subtitles }: { state: TimelineState; subtitles: ExportSubtitleSettings }) {
  const t = useT();
  return (
    <>
      {!subtitles.tracks.length && (
        <InfoCard icon="captions" title={t('字幕轨尚未开启')} text={t('开启字幕并确认内容后，即可下载字幕稿。')} />
      )}
      <Row label={t('字幕轨道')}>
        <select className="cc-export-select" value={subtitles.trackId} disabled={!subtitles.tracks.length} onChange={(event) => subtitles.setTrackId(event.target.value)}>
          {!subtitles.tracks.length && <option value="">—</option>}
          {subtitles.tracks.map((entry) => <option key={entry.id} value={entry.id}>{trackAlias(state, entry.id)}</option>)}
        </select>
      </Row>
      <Row label={t('格式')}>
        <Segmented
          options={[{ value: 'srt', label: 'SubRip (.srt)' }, { value: 'txt', label: '纯文本 (.txt)' }] as const}
          value={subtitles.format}
          onChange={subtitles.setFormat}
        />
      </Row>
    </>
  );
}

interface XmlTabProps {
  nleFormat: 'fcp_xml' | 'fcp_xml_resolve';
  includeMg: boolean;
  mgCount: number;
  setNleFormat: (format: 'fcp_xml' | 'fcp_xml_resolve') => void;
  setIncludeMg: (include: boolean) => void;
}

function XmlTab({ nleFormat, includeMg, mgCount, setNleFormat, setIncludeMg }: XmlTabProps) {
  const t = useT();
  return (
    <>
      <InfoCard icon="clipboard" title={t('可继续编辑的工程')} text={t('生成带轨道与素材引用的 FCPXML，交给 Premiere Pro 或达芬奇继续制作。')} />
      <Row label={t('目标软件')}>
        <Segmented
          options={[{ value: 'fcp_xml', label: 'Premiere Pro' }, { value: 'fcp_xml_resolve', label: '达芬奇' }] as const}
          value={nleFormat}
          onChange={setNleFormat}
        />
      </Row>
      <label className="cc-export-toggle">
        <span><strong>{t('同时打包动态图层')}</strong><small>{t('额外生成带透明通道的 ProRes 4444 MOV。')}</small></span>
        <input type="checkbox" checked={includeMg} onChange={(event) => setIncludeMg(event.target.checked)} disabled={mgCount === 0} />
      </label>
      <p className="cc-export-footnote">{t('导入后，请在剪辑软件中指向原始素材所在文件夹，以重新链接离线片段。')}</p>
    </>
  );
}

export interface ExportTabContentProps extends VideoTabProps, XmlTabProps {
  tab: ExportTab;
  state: TimelineState;
  subtitles: ExportSubtitleSettings;
  mgCount: number;
}

export function ExportTabContent(props: ExportTabContentProps) {
  if (props.tab === 'video') return <VideoTab {...props} />;
  if (props.tab === 'audio') return <AudioTab />;
  if (props.tab === 'mg') return <MotionGraphicsTab count={props.mgCount} />;
  if (props.tab === 'subtitles') return <SubtitlesTab state={props.state} subtitles={props.subtitles} />;
  return <XmlTab {...props} />;
}
