import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../i18n/locale';
import { theme } from '../../theme';
import {
  fetchModelPackCatalog,
  fetchModelPackTask,
  installModelPack,
} from '../../../shared/model-packs/client';
import type { ModelPackStatus, ModelPackTask } from '../../../shared/model-packs/catalog';

const SEMANTIC_PACK_ID = 'visual-semantics-lite' as const;
const PACK_POLL_MS = 1500;

/**
 * 画面语义搜索模型包管理（设置 → 本地模型 → 画面语义搜索）。
 * 只负责模型包的探测 / 下载 / 状态；索引与搜索在媒体池面板内完成。
 */
export function SemanticModelPackPane() {
  const t = useT();
  const [status, setStatus] = useState<ModelPackStatus | 'checking' | 'skipped'>('checking');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const probe = useCallback(async () => {
    try {
      const packs = await fetchModelPackCatalog();
      const pack = packs.find((entry) => entry.id === SEMANTIC_PACK_ID);
      setStatus(pack?.status ?? 'skipped');
    } catch {
      setStatus('skipped');
    }
  }, []);

  useEffect(() => {
    void probe();
  }, [probe]);

  const install = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await installModelPack(SEMANTIC_PACK_ID, {});
      // Poll until the task leaves the downloading state.
      const poll = async (): Promise<void> => {
        const task: ModelPackTask | null = await fetchModelPackTask(SEMANTIC_PACK_ID);
        if (!task) {
          await probe();
          setBusy(false);
          return;
        }
        setProgress(task.bytesTotal > 0 ? (task.bytesDone / task.bytesTotal) * 100 : 0);
        if (task.status === 'downloading') {
          window.setTimeout(() => void poll(), PACK_POLL_MS);
        } else {
          await probe();
          setBusy(false);
        }
      };
      await poll();
    } catch (installError) {
      setError(installError instanceof Error ? installError.message : String(installError));
      setBusy(false);
    }
  }, [probe]);

  const ready = status === 'installed';
  const absent = status === 'absent' || status === 'error';
  const downloading = status === 'downloading' || busy;

  return (
    <section style={sectionStyle} aria-labelledby="semantic-pack-heading">
      <div>
        <div id="semantic-pack-heading" style={{ fontSize: 12.5, fontWeight: 650 }}>
          {t('画面语义搜索模型包')}
        </div>
        <div style={{ marginTop: 3, fontSize: 11.5, color: theme.textDim }}>
          {t('按画面内容搜索素材的本地向量模型（约 178MB）。模型在本机运行，素材不会上传。')}
        </div>
      </div>
      {error && <div role="alert" style={errorStyle}>{t('操作失败：{err}', { err: error })}</div>}
      {status === 'checking' && <div style={hintStyle}>{t('读取中…')}</div>}
      {status === 'skipped' && <div style={hintStyle}>{t('未检测到模型包服务。')}</div>}
      {absent && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <button type="button" style={{ ...smallBtn, ...primaryBtn }} disabled={busy} onClick={() => void install()}>
            {t('下载并启用')}
          </button>
        </div>
      )}
      {downloading && (
        <div style={{ marginTop: 8 }}>
          <progress max={100} value={progress} style={{ width: '100%', height: 5, accentColor: theme.accent }} />
          <div style={{ marginTop: 4, fontSize: 11, color: theme.textDim }}>
            {Math.round(progress)}% · {t('下载中…')}
          </div>
        </div>
      )}
      {ready && (
        <div style={hintStyle}>
          {t('已安装。打开媒体池 → 语义搜索面板即可索引素材并按画面搜索。')}
        </div>
      )}
    </section>
  );
}

const sectionStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 8,
  padding: '10px 0',
};
const hintStyle: React.CSSProperties = {
  fontSize: 11.5, color: theme.textDim, marginTop: 4, lineHeight: 1.5,
};
const errorStyle: React.CSSProperties = {
  fontSize: 11.5, color: theme.danger, marginTop: 4, lineHeight: 1.5,
};
const smallBtn: React.CSSProperties = {
  fontSize: 11.5, padding: '3px 10px', borderRadius: 6,
  border: `0.5px solid ${theme.border}`, background: 'transparent',
  color: theme.text, cursor: 'pointer', whiteSpace: 'nowrap',
};
const primaryBtn: React.CSSProperties = {
  background: theme.accent, color: theme.onAccent, borderColor: 'transparent', fontWeight: 650,
};
