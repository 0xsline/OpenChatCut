import type { TimelineState } from '../editor/types';
import { trackAlias } from '../editor/types';
import { Icon } from '../components/icons';
import { useT } from '../i18n/locale';
import { captionCues, mediaItems } from '../agent/tools/jianying-export-tool';
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
import { fcpxmlBackgroundFillCount } from './fcpxml';
import { useState } from 'react';

/** macOS default store for the Chinese JianYing (剪映专业版) app; drafts in 6.0+
 * are encrypted and capcut-cli cannot decrypt them, hence the ≤5.9 note. */
const JIANYING_STORE = '~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft';

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
          ? t('高清优先预览；导出默认高码率，不主动压缩导入素材。')
          : t('平衡流畅与体积；预览可用轻量副本，导出默认自动码率。')}
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
  state: TimelineState;
  nleFormat: 'fcp_xml' | 'fcp_xml_resolve';
  includeMg: boolean;
  mgCount: number;
  setNleFormat: (format: 'fcp_xml' | 'fcp_xml_resolve') => void;
  setIncludeMg: (include: boolean) => void;
}

function XmlTab({ state, nleFormat, includeMg, mgCount, setNleFormat, setIncludeMg }: XmlTabProps) {
  const t = useT();
  const backgroundFillCount = fcpxmlBackgroundFillCount(state);
  return (
    <>
      <InfoCard icon="clipboard" title={t('可继续编辑的工程')} text={t('生成带轨道与素材引用的 FCPXML，交给 Premiere Pro 或达芬奇继续制作。')} />
      {backgroundFillCount > 0 && (
        <InfoCard
          icon="film"
          title={t('当前 FCPXML 会保留背景参数，但不生成图层')}
          text={t('OpenChatCut 会把 {n} 个片段的背景填充开关与百分比写入 FCPXML 元数据，但目标剪辑软件不会据此还原模糊图层；如需完全一致，请同时导出成片。', {
            n: backgroundFillCount,
          })}
        />
      )}
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

interface JianyingExportOutcome {
  draftName: string;
  draftPath: string;
  addedVideos: number;
  addedAudios: number;
  captions: number;
  warnings: string[];
}

function JianyingTab({ state, base }: { state: TimelineState; base: string }) {
  const t = useT();
  const [draftName, setDraftName] = useState(base);
  const [store, setStore] = useState<'capcut' | 'jianying'>('capcut');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<JianyingExportOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const body = {
        draftName: draftName.trim(),
        fps: state.fps,
        items: mediaItems(state.items).map((item) => ({
          kind: item.kind,
          src: item.src ?? '',
          startFrame: item.startFrame,
          durationInFrames: item.durationInFrames,
          volume: item.volume,
          name: item.name,
        })),
        captions: captionCues(state, state.captions),
        draftsDir: store === 'jianying' ? JIANYING_STORE : '',
      };
      const response = await fetch('/api/external-agent/jianying-export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await response.json().catch(() => null)) as (JianyingExportOutcome & { ok?: boolean; error?: string }) | null;
      if (!response.ok || !data?.ok) {
        setError(data?.error ?? t('剪映草稿导出失败'));
        return;
      }
      setOutcome(data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <InfoCard icon="video" title={t('生成剪映草稿')}
        text={t('把时间线上的视频、音轨与字幕写入本地草稿库，用剪映或 CapCut 打开即可继续剪辑。')} />
      <Row label={t('草稿名称')}>
        <input className="cc-export-select" value={draftName}
          onChange={(event) => setDraftName(event.target.value)} disabled={busy} />
      </Row>
      <Row label={t('目标草稿库')}>
        <Segmented
          options={[{ value: 'capcut', label: 'CapCut 草稿库' }, { value: 'jianying', label: '剪映草稿库' }] as const}
          value={store}
          onChange={setStore}
        />
      </Row>
      {store === 'jianying' && <p className="cc-export-footnote">{JIANYING_STORE}</p>}
      <p className="cc-export-footnote">
        {t('剪映 6.0 起草稿文件已加密，本工具生成明文草稿，建议使用剪映 5.9.0 或更早版本打开；CapCut 国际版不受此限制。')}
      </p>
      {error && <p className="cc-export-error" role="alert">{error}</p>}
      {outcome && (
        <div className="cc-export-info">
          <span><Icon name="check" size={19} /></span>
          <div>
            <strong>{t('草稿已生成')} · {outcome.draftName}</strong>
            <p>
              {t('{videos} 个视频 · {audios} 个音轨 · {captions} 条字幕', {
                videos: outcome.addedVideos,
                audios: outcome.addedAudios,
                captions: outcome.captions,
              })}
              <br />
              {outcome.draftPath}
              {outcome.warnings.length > 0 && (
                <><br />{outcome.warnings.join('；')}</>
              )}
            </p>
          </div>
        </div>
      )}
      <button type="button" className="cc-export-cta" onClick={() => void run()} disabled={busy}>
        {!busy && <Icon name="download" size={17} />}
        {busy ? t('正在生成草稿…') : t('导出到剪映')}
      </button>
    </>
  );
}

export interface ExportTabContentProps extends VideoTabProps, XmlTabProps {
  tab: ExportTab;
  state: TimelineState;
  subtitles: ExportSubtitleSettings;
  mgCount: number;
  base: string;
}

export function ExportTabContent(props: ExportTabContentProps) {
  if (props.tab === 'video') return <VideoTab {...props} />;
  if (props.tab === 'audio') return <AudioTab />;
  if (props.tab === 'mg') return <MotionGraphicsTab count={props.mgCount} />;
  if (props.tab === 'subtitles') return <SubtitlesTab state={props.state} subtitles={props.subtitles} />;
  if (props.tab === 'jianying') return <JianyingTab state={props.state} base={props.base} />;
  return <XmlTab {...props} />;
}
