// Settings → 转写 → 本地模型：模型选择 + 按需下载管理。
// Models are NOT bundled — users pick and download them on demand through the
// local hf-proxy (multi-source accelerated download into the disk cache).
// Whisper is OpenAI's open-source model, so the official OpenAI mark is used.
import { useCallback, useEffect, useRef, useState } from 'react';
import { theme } from '../../theme';
import { useT } from '../../i18n/locale';
import { warmUpLocalAsr } from '../../transcript/local-asr';
import { asrBackendPreference } from '../../transcript/deviceProfile';
import { VendorIcon } from './vendorIcons';
import type { AsrDownloadStatus } from '../../../shared/asr-models';
import { FieldRow, type FieldCtx } from './settingsVendorPane';
import type { SettingsField } from './settingsSchema';
import { mutateLocalAsrModel } from './local-asr-model-mutation';
import {
  desktopNativeInferenceEnabled,
  setDesktopNativeInferenceEnabled,
} from '../../transcript/desktop-inference-preference';

interface AsrModelState {
  id: string;
  modelId: string;
  label: string;
  sizeLabel: string;
  language: string;
  downloaded: boolean;
  bytes: number;
  task?: {
    status: AsrDownloadStatus;
    bytesDone?: number;
    bytesTotal?: number;
    filesDone?: number;
    filesTotal?: number;
    error?: string;
  };
}

const POLL_MS = 1500;

function modelSizeText(bytes: number): string {
  if (bytes <= 0) return '';
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? ` · ${(mb / 1024).toFixed(1)}GB` : ` · ${Math.round(mb)}MB`;
}

export function LocalAsrPane({ fields, ctx }: { fields: readonly SettingsField[]; ctx: FieldCtx }) {
  const t = useT();
  const [models, setModels] = useState<AsrModelState[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const hasDesktopInference = Boolean(window.openChatCutDesktop?.inference);
  const [nativeInference, setNativeInference] = useState(desktopNativeInferenceEnabled);
  const [desktopInferenceSupported, setDesktopInferenceSupported] = useState(false);
  const [webgpuAccel, setWebgpuAccel] = useState(() => asrBackendPreference() === 'webgpu');
  useEffect(() => {
    let active = true;
    const inference = window.openChatCutDesktop?.inference;
    if (inference) {
      void inference.getCapabilities()
        .then((capabilities) => {
          if (active) {
            setDesktopInferenceSupported(
              capabilities.platform === 'darwin' || capabilities.platform === 'win32',
            );
          }
        })
        .catch(() => undefined);
    }
    return () => { active = false; };
  }, []);
  const toggleNativeInference = useCallback((enabled: boolean) => {
    void setDesktopNativeInferenceEnabled(enabled)
      .then(() => setNativeInference(enabled))
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : String(error));
      });
  }, []);
  const toggleWebgpuAccel = useCallback((enabled: boolean) => {
    try {
      if (enabled) {
        localStorage.setItem('cc.asrBackend', 'webgpu');
        // Re-allow WebGPU attempts when the user re-enables the toggle.
        localStorage.removeItem('cc.asrWebgpuBroken');
      } else {
        localStorage.removeItem('cc.asrBackend');
      }
    } catch {
      // Best-effort preference persistence.
    }
    setWebgpuAccel(enabled);
  }, []);

  const downloadingRef = useRef<ReadonlySet<string>>(new Set());
  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/asr-models', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { models?: AsrModelState[] };
      const models = Array.isArray(body.models) ? body.models : [];
      setModels(models);
      setLoadError(null);
      const current = new Set(models.filter((m) => m.task?.status === 'downloading').map((m) => m.id));
      // A download just finished: warm the configured model with this catalog
      // snapshot, avoiding a duplicate API request.
      if (downloadingRef.current.size > 0 && current.size === 0) {
        const downloadedIds = models.filter((model) => model.downloaded).map((model) => model.modelId);
        void warmUpLocalAsr(downloadedIds);
      }
      downloadingRef.current = current;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const anyDownloading = (models ?? []).some((m) => m.task?.status === 'downloading');
  useEffect(() => {
    if (!anyDownloading) return;
    const timer = setInterval(() => { void refresh(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [anyDownloading, refresh]);

  const startDownload = useCallback(async (id: string) => {
    setBusyId(id);
    try {
      await mutateLocalAsrModel('download', id);
      await refresh();
    } finally {
      setBusyId(null);
    }
  }, [refresh]);

  const deleteModel = useCallback(async (id: string) => {
    setBusyId(id);
    try {
      await mutateLocalAsrModel('delete', id);
      await refresh();
    } finally {
      setBusyId(null);
    }
  }, [refresh]);

  const statusLabel = (m: AsrModelState): { text: string; color: string } => {
    const task = m.task;
    if (task?.status === 'downloading') {
      // Byte totals are unknown before a file finishes; file-level progress
      // advances reliably (configs first, then the big ONNX weights).
      const pct = (task.filesTotal ?? 0) > 0
        ? Math.min(100, Math.round((task.filesDone ?? 0) / (task.filesTotal ?? 1) * 100))
        : 0;
      return { text: t('下载中 {pct}%', { pct }), color: theme.accent };
    }
    if (task?.status === 'error') return { text: t('下载失败'), color: theme.danger };
    if (m.downloaded) return { text: t('已下载'), color: theme.success };
    return { text: t('未下载'), color: theme.textDim };
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <VendorIcon vendor="openai" size={16} />
        <span style={{ fontSize: 12, fontWeight: 600 }}>{t('默认模型')}</span>
      </div>
      {fields.map((field) => <FieldRow key={field.name} field={field} ctx={ctx} />)}
      {hasDesktopInference && desktopInferenceSupported && (
        <label style={{
          display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px',
          border: `0.5px solid ${theme.border}`, borderRadius: 8, background: theme.panel,
        }}>
          <input
            type="checkbox"
            checked={nativeInference}
            onChange={(event) => toggleNativeInference(event.target.checked)}
            style={{ marginTop: 2 }}
          />
          <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>{t('桌面原生推理加速')}</span>
            <span style={{ fontSize: 11, color: theme.textDim, lineHeight: 1.45 }}>
              {t('启用后，转写、画面语义、节拍与音乐语义模型自动选择 Windows DirectML 或 macOS CoreML/原生 CPU；转写模型在编辑器打开后后台预热，其他模型首次使用时按需加载；失败时回退浏览器引擎。')}
            </span>
          </span>
        </label>
      )}
      <label style={{
        display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px',
        border: `0.5px solid ${theme.border}`, borderRadius: 8, background: theme.panel,
      }}>
        <input
          type="checkbox"
          checked={webgpuAccel}
          onChange={(event) => toggleWebgpuAccel(event.target.checked)}
          style={{ marginTop: 2 }}
        />
        <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>{t('WebGPU 转写加速')}</span>
        </span>
      </label>
      <div style={{ fontSize: 11.5, color: theme.textDim }}>
        {t('模型按需下载到本机，不随应用打包。首次使用或下载模型时自动加速下载。')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
        {loadError && <div style={{ fontSize: 11.5, color: theme.danger }}>{t('无法读取模型列表：{err}', { err: loadError })}</div>}
        {!loadError && !models && <div style={{ fontSize: 11.5, color: theme.textDim }}>{t('读取中…')}</div>}
        {(models ?? []).map((m) => {
          const status = statusLabel(m);
          const downloading = m.task?.status === 'downloading';
          const busy = busyId === m.id;
          return (
            <div key={m.id} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 10px', borderRadius: 8,
              border: `0.5px solid ${theme.border}`, background: theme.panel,
            }}>
              <VendorIcon vendor="openai" size={18} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>{m.label}</div>
                <div style={{ fontSize: 11, color: theme.textDim }}>
                  {m.language}{m.sizeLabel ? ` · ${m.sizeLabel}` : ''}{modelSizeText(m.bytes)}
                </div>
              </div>
              <span style={{ fontSize: 11, color: status.color, whiteSpace: 'nowrap' }}>{status.text}</span>
              {downloading ? (
                <span style={{ fontSize: 11, color: theme.textDim }}>…</span>
              ) : m.downloaded ? (
                <button type="button" disabled={busy} onClick={() => void deleteModel(m.id)}
                  style={smallBtn}>{t('删除')}</button>
              ) : (
                <button type="button" disabled={busy} onClick={() => void startDownload(m.id)}
                  style={{ ...smallBtn, ...primaryBtn }}>{t('下载')}</button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const smallBtn: React.CSSProperties = {
  fontSize: 11.5, padding: '3px 10px', borderRadius: 6,
  border: `0.5px solid ${theme.border}`, background: 'transparent',
  color: theme.text, cursor: 'pointer', whiteSpace: 'nowrap',
};
const primaryBtn: React.CSSProperties = {
  borderColor: theme.accent, color: theme.accent,
};
