import { useEffect, useState } from 'react';
import { toDataURL } from 'qrcode';
import { Icon } from '../components/icons';
import { useT } from '../i18n/locale';
import type { MobileUploadRecord, MobileUploadSession } from './mobileUploadApi';
import { useMobileUploadSession } from './useMobileUploadSession';
import './mobile-upload.css';

interface MobileUploadDialogProps {
  onClose: () => void;
  onImport: (record: MobileUploadRecord) => Promise<void>;
}

const QR_SIZE_PX = 240;
const CLOCK_INTERVAL_MS = 1000;

function useQrDataUrl(url: string): { dataUrl: string; error: boolean } {
  const [dataUrl, setDataUrl] = useState('');
  const [error, setError] = useState(false);
  useEffect(() => {
    setError(false);
    if (!url) { setDataUrl(''); return; }
    let active = true;
    void toDataURL(url, { width: QR_SIZE_PX, margin: 1, errorCorrectionLevel: 'M' })
      .then((data) => { if (active) setDataUrl(data); })
      .catch(() => { if (active) { setDataUrl(''); setError(true); } });
    return () => { active = false; };
  }, [url]);
  return { dataUrl, error };
}

function SessionBody({ session, imported }: { session: MobileUploadSession; imported: number }) {
  const t = useT();
  const [selectedUrl, setSelectedUrl] = useState(session.urls[0] ?? '');
  const [now, setNow] = useState(Date.now());
  const { dataUrl: qrDataUrl, error: qrError } = useQrDataUrl(selectedUrl);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((session.expiresAt - now) / CLOCK_INTERVAL_MS));
  const copyLink = () => {
    void navigator.clipboard.writeText(selectedUrl)
      .catch(() => { window.prompt(t('复制失败，请手动复制链接'), selectedUrl); });
  };
  return <div className="cc-mobile-upload-body">
    <div className="cc-mobile-upload-qr">{qrDataUrl ? <img src={qrDataUrl} alt={t('手机上传二维码')} /> : <span>{t(qrError ? '二维码生成失败，请复制链接' : '正在生成二维码…')}</span>}</div>
    <div className="cc-mobile-upload-instructions">
      <ol><li>{t('让手机与电脑连接同一 Wi-Fi')}</li><li>{t('使用手机相机扫描二维码')}</li><li>{t('选择素材，上传完成后会自动进入媒体池')}</li></ol>
      {session.urls.length > 1 && <label>{t('局域网地址')}<select value={selectedUrl} onChange={(event) => setSelectedUrl(event.target.value)}>{session.urls.map((url) => <option key={url} value={url}>{new URL(url).host}</option>)}</select></label>}
      <div className="cc-mobile-upload-link"><code>{selectedUrl}</code><button type="button" onClick={copyLink}>{t('复制链接')}</button></div>
      <p>{seconds > 0 ? t('通道将在 {seconds} 秒后关闭', { seconds }) : t('上传通道已过期，请关闭后重试')}</p>
      <div className="cc-mobile-upload-count"><span className="cc-mobile-upload-live" />{t('已接收并导入 {n} 个素材', { n: imported })}</div>
    </div>
  </div>;
}

function DialogHeader({ close }: { close: () => void }) {
  const t = useT();
  return <header><div><strong>{t('手机传素材')}</strong><span>{t('扫码后从手机选择视频、图片或音频')}</span></div><button type="button" aria-label={t('关闭')} onClick={close}><Icon name="x" size={18} /></button></header>;
}

export function MobileUploadDialog({ onClose, onImport }: MobileUploadDialogProps) {
  const t = useT();
  const { session, error, imported, finish } = useMobileUploadSession(onImport);
  const [closing, setClosing] = useState(false);
  const close = () => {
    if (closing) return;
    setClosing(true);
    void finish().finally(onClose);
  };
  return <div className="cc-modal-backdrop" role="dialog" aria-modal="true" aria-label={t('手机传素材')} onClick={close}>
    <div className="cc-mobile-upload-dialog" onClick={(event) => event.stopPropagation()}>
      <DialogHeader close={close} />
      {!session && !error && <div className="cc-mobile-upload-loading">{t('正在建立局域网上传通道…')}</div>}
      {session && <SessionBody session={session} imported={imported} />}
      {error && <div className="cc-mobile-upload-error">{t('手机上传不可用：{error}', { error })}</div>}
      <footer><span>{t('仅在本次会话中临时开放素材上传，不会暴露编辑器或 API 密钥。')}</span><button type="button" disabled={closing} onClick={close}>{closing ? t('正在完成导入…') : t('完成')}</button></footer>
    </div>
  </div>;
}
