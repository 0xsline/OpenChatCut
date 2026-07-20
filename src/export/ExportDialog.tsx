// 导出设置对话框(submit_export 全参数面,5 tab):
//   视频  codec h264/vp8 + 分辨率 480/720/1080p + 帧率 24/25/30/50/60(缺省跟时间线)
//   音频  mp3(视频轨忽略)
//   MG动画 全部 MG 逐个渲成带 alpha 的 ProRes 4444 .mov
//   字幕  srt / txt(需先开启字幕)
//   XML   fcp_xml(Premiere)/ fcp_xml_resolve(达芬奇)± 随包渲出 MG .mov
// 「创建分享链接」(云端公开页)需要分享后端——本地无,不摆假开关。
import { useMemo, useState } from 'react';
import { useT } from '../i18n/locale';
import { Icon, type IconName } from '../components/icons';
import type { TimelineState } from '../editor/types';
import { timelineToFcpxml } from './fcpxml';
import { captionsToSrt, captionsToTxt } from '../captions/exportCaptions';
import { exportClipMov } from '../media/clipExport';
import { sanitizeFileName } from '../media/fileName';
import { recordExport } from '../persist/exportHistoryStore';

type ExportTab = 'video' | 'audio' | 'mg' | 'subtitles' | 'xml';

interface ExportDialogProps {
  state: TimelineState;
  projectName: string;
  onClose: () => void;
}

const TABS: Array<{ key: ExportTab; label: string; summary: string; icon: IconName }> = [
  { key: 'video', label: '成片', summary: 'MP4 / WebM', icon: 'film' },
  { key: 'audio', label: '音轨', summary: 'MP3', icon: 'music' },
  { key: 'mg', label: '动态图层', summary: 'ProRes 4444', icon: 'sparkles' },
  { key: 'subtitles', label: '字幕稿', summary: 'SRT / TXT', icon: 'captions' },
  { key: 'xml', label: '剪辑工程', summary: 'FCPXML', icon: 'clipboard' },
];

const FPS_OPTIONS = [24, 25, 30, 50, 60];
const RESOLUTIONS = ['480p', '720p', '1080p'] as const;

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function ExportDialog({ state, projectName, onClose }: ExportDialogProps) {
  const t = useT();
  const [tab, setTab] = useState<ExportTab>('video');
  const [codec, setCodec] = useState<'h264' | 'vp8'>('h264');
  // 分辨率默认档 = 时间线短边就近(1080×1920 → 1080p)
  const defaultRes = useMemo(() => {
    const minSide = Math.min(state.width, state.height);
    if (minSide <= 480) return '480p';
    if (minSide <= 720) return '720p';
    return '1080p';
  }, [state.width, state.height]);
  const [resolution, setResolution] = useState<(typeof RESOLUTIONS)[number]>(defaultRes);
  // 帧率默认 = 时间线 fps 落进档位(不在档位则取 30)
  const [fps, setFps] = useState<number>(FPS_OPTIONS.includes(state.fps) ? state.fps : 30);
  const [subtitleFormat, setSubtitleFormat] = useState<'srt' | 'txt'>('srt');
  const [nleFormat, setNleFormat] = useState<'fcp_xml' | 'fcp_xml_resolve'>('fcp_xml');
  const [includeMg, setIncludeMg] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mgItems = useMemo(() => state.items.filter((it) => it.kind === 'motion-graphic'), [state.items]);
  const base = sanitizeFileName(projectName, 'export');
  const activeTab = TABS.find((entry) => entry.key === tab) ?? TABS[0];
  const outputName = tab === 'video'
    ? `${base}.${codec === 'vp8' ? 'webm' : 'mp4'}`
    : tab === 'audio' ? `${base}.mp3`
      : tab === 'subtitles' ? `${base}.${subtitleFormat}`
        : tab === 'xml' ? `${base}-${nleFormat === 'fcp_xml_resolve' ? 'resolve' : 'premiere'}.fcpxml`
          : t('{n} 个透明 MOV 文件', { n: mgItems.length });
  const actionLabel: Record<ExportTab, string> = {
    video: '导出成片',
    audio: '提取音轨',
    mg: '导出动态图层',
    subtitles: '下载字幕',
    xml: '生成剪辑工程',
  };

  /** 视频/音频:POST /export(服务端无头渲染)→ 下载。 */
  const exportMedia = async (format: 'video' | 'audio') => {
    const useCodec = format === 'audio' ? 'mp3' : codec;
    const body: Record<string, unknown> = { state, format, codec: useCodec, name: base };
    if (format === 'video') {
      body.resolution = resolution;
      if (fps !== state.fps) body.fps = fps;
    }
    const res = await fetch('/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
      const info = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(info?.error ?? t('导出失败 ({status})', { status: res.status }));
    }
    const blob = await res.blob();
    const ext = format === 'audio' ? 'mp3' : useCodec === 'vp8' ? 'webm' : 'mp4';
    downloadBlob(blob, `${base}.${ext}`);
    void recordExport({ name: `${base}.${ext}`, format, codec: useCodec, sizeBytes: blob.size, createdAt: Date.now() });
  };

  /** MG动画:逐个渲 ProRes 4444 alpha .mov(复用单片段导出管线)。 */
  const exportMgBatch = async () => {
    for (let i = 0; i < mgItems.length; i++) {
      setBusy(t('渲染 MG {i}/{n} · {name}', { i: i + 1, n: mgItems.length, name: mgItems[i].name }));
      await exportClipMov(state, mgItems[i]);
    }
    void recordExport({ name: `${mgItems.length} 个 MG · ProRes 4444`, format: 'video', codec: 'prores', createdAt: Date.now() });
  };

  const exportSubtitles = () => {
    if (!state.captions) throw new Error(t('请先开启字幕'));
    const text = subtitleFormat === 'srt'
      ? captionsToSrt(state.captions, state.items, state.fps)
      : captionsToTxt(state.captions, state.items, state.fps);
    if (!text) throw new Error(t('当前字幕轨没有可导出的内容'));
    downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), `${base}.${subtitleFormat}`);
    void recordExport({ name: `${base}.${subtitleFormat}`, format: 'subtitles', createdAt: Date.now() });
  };

  const exportXml = async () => {
    if (includeMg) {
      for (let i = 0; i < mgItems.length; i++) {
        setBusy(t('渲染 MG {i}/{n} · {name}', { i: i + 1, n: mgItems.length, name: mgItems[i].name }));
        await exportClipMov(state, mgItems[i]);
      }
    }
    const xml = timelineToFcpxml(state, { title: projectName, nleFormat });
    const suffix = nleFormat === 'fcp_xml_resolve' ? 'resolve' : 'premiere';
    downloadBlob(new Blob([xml], { type: 'application/xml;charset=utf-8' }), `${base}-${suffix}.fcpxml`);
    void recordExport({ name: `${base}-${suffix}.fcpxml`, format: 'xml', createdAt: Date.now() });
  };

  const run = async () => {
    if (busy) return;
    setError(null);
    setBusy(t('导出中…'));
    try {
      if (tab === 'video') await exportMedia('video');
      else if (tab === 'audio') await exportMedia('audio');
      else if (tab === 'mg') await exportMgBatch();
      else if (tab === 'subtitles') exportSubtitles();
      else await exportXml();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('导出失败'));
    } finally {
      setBusy(null);
    }
  };

  const disabled = !!busy
    || (tab === 'subtitles' && !state.captions)
    || (tab === 'mg' && mgItems.length === 0);

  return (
    <div className="cc-export-overlay" onClick={busy ? undefined : onClose}>
      <div
        className="cc-export-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cc-export-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="cc-export-header">
          <div>
            <h2 id="cc-export-title">{t('导出')}</h2>
            <p>{base} · {state.width}×{state.height} · {state.fps} fps</p>
          </div>
          <button type="button" className="cc-export-close" onClick={onClose} disabled={!!busy} title={t('关闭')}>
            <Icon name="x" size={16} />
          </button>
        </header>

        <div className="cc-export-layout">
          <aside className="cc-export-sidebar">
            <span className="cc-export-sidebar-label">{t('输出类型')}</span>
            <div className="cc-export-tabs" role="tablist" aria-label={t('输出类型')}>
              {TABS.map((entry) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === entry.key}
                  aria-controls={`cc-export-content-${entry.key}`}
                  id={`cc-export-tab-${entry.key}`}
                  key={entry.key}
                  className={`cc-export-tab${tab === entry.key ? ' active' : ''}`}
                  onClick={() => { setTab(entry.key); setError(null); }}
                >
                  <span className="cc-export-tab-icon"><Icon name={entry.icon} size={15} /></span>
                  <span>
                    <strong>{t(entry.label)}</strong>
                    <small>{entry.summary}</small>
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <main className="cc-export-main">
            <div className="cc-export-main-header">
              <div>
                <h3>{t(activeTab.label)}</h3>
                <p>{activeTab.summary}</p>
              </div>
              <span className="cc-export-local-badge"><i />{t('本机渲染')}</span>
            </div>

            <div
              className="cc-export-content"
              role="tabpanel"
              id={`cc-export-content-${tab}`}
              aria-labelledby={`cc-export-tab-${tab}`}
            >
              {tab === 'video' && (
                <>
                  <Row label={t('编码')}>
                    <select className="cc-export-select" value={codec} onChange={(event) => setCodec(event.target.value as 'h264' | 'vp8')}>
                      <option value="h264">MP4 (H.264)</option>
                      <option value="vp8">WebM (VP8)</option>
                    </select>
                  </Row>
                  <Row label={t('分辨率')}>
                    <Segmented options={RESOLUTIONS.map((value) => ({ value, label: value }))} value={resolution} onChange={setResolution} />
                  </Row>
                  <Row label={t('帧率')}>
                    <Segmented options={FPS_OPTIONS.map((value) => ({ value, label: `${value} fps` }))} value={fps} onChange={setFps} />
                  </Row>
                </>
              )}

              {tab === 'audio' && (
                <InfoCard icon="music" title={t('MP3 音轨')} text={t('提取时间线中的完整混音，视频画面不会写入文件。')} />
              )}

              {tab === 'mg' && (
                <InfoCard
                  icon="sparkles"
                  title={mgItems.length ? t('{n} 个动态图层', { n: mgItems.length }) : t('没有可导出的动态图层')}
                  text={mgItems.length
                    ? t('逐个生成带透明通道的 ProRes 4444 MOV，方便在其他工程中复用。')
                    : t('先在时间线上添加 MG 动画，再从这里生成透明素材。')}
                />
              )}

              {tab === 'subtitles' && (
                <>
                  {!state.captions && (
                    <InfoCard icon="captions" title={t('字幕轨尚未开启')} text={t('开启字幕并确认内容后，即可下载字幕稿。')} />
                  )}
                  <Row label={t('格式')}>
                    <Segmented
                      options={[{ value: 'srt', label: 'SubRip (.srt)' }, { value: 'txt', label: '纯文本 (.txt)' }] as const}
                      value={subtitleFormat} onChange={setSubtitleFormat}
                    />
                  </Row>
                </>
              )}

              {tab === 'xml' && (
                <>
                  <InfoCard icon="clipboard" title={t('可继续编辑的工程')} text={t('生成带轨道与素材引用的 FCPXML，交给 Premiere Pro 或达芬奇继续制作。')} />
                  <Row label={t('目标软件')}>
                    <Segmented
                      options={[{ value: 'fcp_xml', label: 'Premiere Pro' }, { value: 'fcp_xml_resolve', label: '达芬奇' }] as const}
                      value={nleFormat} onChange={setNleFormat}
                    />
                  </Row>
                  <label className="cc-export-toggle">
                    <span>
                      <strong>{t('同时打包动态图层')}</strong>
                      <small>{t('额外生成带透明通道的 ProRes 4444 MOV。')}</small>
                    </span>
                    <input type="checkbox" checked={includeMg} onChange={(event) => setIncludeMg(event.target.checked)}
                      disabled={mgItems.length === 0} />
                  </label>
                  <p className="cc-export-footnote">{t('导入后，请在剪辑软件中指向原始素材所在文件夹，以重新链接离线片段。')}</p>
                </>
              )}

              {error && <p className="cc-export-error">{error}</p>}
            </div>

            <footer className="cc-export-footer">
              <div className="cc-export-output">
                <span>{t('即将生成')}</span>
                <strong title={outputName}>{outputName}</strong>
              </div>
              <button
                type="button"
                className="cc-export-cta"
                onClick={() => void run()}
                disabled={disabled}
              >
                {!busy && <Icon name="download" size={17} />}
                {busy ?? t(actionLabel[tab])}
              </button>
            </footer>
          </main>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="cc-export-field">
      <span>{label}</span>
      {children}
    </div>
  );
}

function InfoCard({ icon, title, text }: { icon: IconName; title: string; text: string }) {
  return (
    <div className="cc-export-info">
      <span><Icon name={icon} size={19} /></span>
      <div>
        <strong>{title}</strong>
        <p>{text}</p>
      </div>
    </div>
  );
}

function Segmented<T extends string | number>({ options, value, onChange }: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  const t = useT();
  return (
    <div className="cc-export-segmented">
      {options.map((option) => (
        <button type="button" key={String(option.value)} className={`cc-export-seg${option.value === value ? ' active' : ''}`} onClick={() => onChange(option.value)}>
          {t(option.label)}
        </button>
      ))}
    </div>
  );
}
