import { Icon } from '../components/icons';
import { useT } from '../i18n/locale';
import type { ExportDestination } from './exportDestination';

interface ExportDestinationBarProps {
  busy: boolean;
  choosing: boolean;
  destination: ExportDestination;
  onChoose: () => Promise<void>;
}

export function ExportDestinationBar({
  busy,
  choosing,
  destination,
  onChoose,
}: ExportDestinationBarProps) {
  const t = useT();
  const downloads = destination.type === 'downloads';
  return (
    <div className="cc-export-destination">
      <span className="cc-export-destination-icon"><Icon name="folder" size={16} /></span>
      <span className="cc-export-destination-copy">
        <small>{t('保存到')}</small>
        <strong title={destination.label}>{downloads ? t('浏览器下载目录') : destination.label}</strong>
        {destination.type !== 'browser-file' && (
          <i>{downloads ? t('保存位置由浏览器下载设置决定') : t('文件将直接写入所选文件夹')}</i>
        )}
      </span>
      <button type="button" onClick={() => void onChoose()} disabled={busy || choosing}>
        {choosing ? t('正在选择…') : downloads ? t('选择…') : t('更改…')}
      </button>
    </div>
  );
}
