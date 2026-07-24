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
      .catch(() => { window.prompt(t('Copy failed, please copy the link manually'), selectedUrl); });
  };
  return <div className="cc-mobile-upload-body">
    <div className="cc-mobile-upload-qr">{qrDataUrl ? <img src={qrDataUrl} alt={t('Upload QR code via mobile phone')} /> : <span>{t(qrError ? 'QR code generation failed, please copy the link' : 'Generating QR code...')}</span>}</div>
    <div className="cc-mobile-upload-instructions">
      <ol><li>{t('Connect your phone and computer to the same Wi-Fi')}</li><li>{t('Use your phone camera to scan the QR code')}</li><li>{t('Select the material and it will automatically enter the media pool after uploading.')}</li></ol>
      {session.urls.length > 1 && <label>{t('LAN address')}<select value={selectedUrl} onChange={(event) => setSelectedUrl(event.target.value)}>{session.urls.map((url) => <option key={url} value={url}>{new URL(url).host}</option>)}</select></label>}
      <div className="cc-mobile-upload-link"><code>{selectedUrl}</code><button type="button" onClick={copyLink}>{t('Copy link')}</button></div>
      <p>{seconds > 0 ? t('The channel will be in {seconds} Close after seconds', { seconds }) : t('The upload channel has expired, please close it and try again')}</p>
      <div className="cc-mobile-upload-count"><span className="cc-mobile-upload-live" />{t('Received and imported {n} materials', { n: imported })}</div>
    </div>
  </div>;
}

function DialogHeader({ close }: { close: () => void }) {
  const t = useT();
  return <header><div><strong>{t('Transfer material via mobile phone')}</strong><span>{t('Scan the QR code and select videos, pictures or audios from your phone')}</span></div><button type="button" aria-label={t('close')} onClick={close}><Icon name="x" size={18} /></button></header>;
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
  return <div className="cc-modal-backdrop" role="dialog" aria-modal="true" aria-label={t('Transfer material via mobile phone')} onClick={close}>
    <div className="cc-mobile-upload-dialog" onClick={(event) => event.stopPropagation()}>
      <DialogHeader close={close} />
      {!session && !error && <div className="cc-mobile-upload-loading">{t('Establishing LAN upload channel...')}</div>}
      {session && <SessionBody session={session} imported={imported} />}
      {error && <div className="cc-mobile-upload-error">{t('Mobile upload is not available:{error}', { error })}</div>}
      <footer><span>{t('Only temporarily open material upload in this session, will not expose the editor or API key.')}</span><button type="button" disabled={closing} onClick={close}>{closing ? t('Completing import...') : t('Complete')}</button></footer>
    </div>
  </div>;
}
