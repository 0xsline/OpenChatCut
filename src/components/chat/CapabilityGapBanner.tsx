import { useEffect, useState } from 'react';
import type { CapabilityKey } from '../../agent/capabilities';
import { currentCaps } from '../../agent/capabilities';
import { getLocale } from '../../i18n/locale';
import { LOCAL_ASR_SETTINGS_ROUTE } from '../settings/settingsMediaProviders';
import {
  fetchLocalAsrCatalog,
  LOCAL_ASR_MODELS_CHANGE_EVENT,
} from '../../transcript/local-asr-readiness';
import {
  CAPABILITY_LABELS,
  formatCapabilityNames,
  missingCreativeCaps,
  transcriptionAvailability,
  type TranscriptionAvailability,
} from './capabilityBanner';
import type { ChatPanelController } from './chatPanelController';

type Translate = (key: string, params?: Record<string, string | number>) => string;

interface CapabilityBannerViewProps {
  readonly t: Translate;
  readonly missing: readonly CapabilityKey[];
  /** The free offline transcription engine is offered but its model is not downloaded. */
  readonly needsLocalModel: boolean;
  readonly onOpenSettings: (route?: string) => void;
}

export function CapabilityBannerView({ t, missing, needsLocalModel, onOpenSettings }: CapabilityBannerViewProps) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || (missing.length === 0 && !needsLocalModel)) return null;
  const names = formatCapabilityNames(
    missing.map((key) => t(CAPABILITY_LABELS[key] ?? key)),
    getLocale(),
  );
  return <>
    {missing.length > 0 && <div className="cc-chat-capability-banner">
      <span>{t('以下能力未配置，相关功能暂不可用：')}{names}</span>
      <button type="button" onClick={() => onOpenSettings()}>{t('去设置配置')}</button>
      <button type="button" className="cc-chat-capability-banner-close" aria-label={t('关闭')}
        onClick={() => setDismissed(true)}>×</button>
    </div>}
    {needsLocalModel && <div className="cc-chat-capability-banner">
      <span>{t('本地转写模型尚未下载：它免费、可离线使用，无需 API Key。')}</span>
      <button type="button" onClick={() => onOpenSettings(LOCAL_ASR_SETTINGS_ROUTE)}>{t('去下载模型')}</button>
      <button type="button" className="cc-chat-capability-banner-close" aria-label={t('关闭')}
        onClick={() => setDismissed(true)}>×</button>
    </div>}
  </>;
}

export function CapabilityBanner({ controller }: { controller: ChatPanelController }) {
  const { props, t } = controller;
  // Undefined until the catalog lands: do not accuse the free path before reading it.
  const [localAsr, setLocalAsr] = useState<TranscriptionAvailability | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    const sync = (): void => {
      void fetchLocalAsrCatalog().then((catalog) => {
        if (alive) setLocalAsr(transcriptionAvailability(catalog));
      });
    };
    sync();
    window.addEventListener(LOCAL_ASR_MODELS_CHANGE_EVENT, sync);
    return () => {
      alive = false;
      window.removeEventListener(LOCAL_ASR_MODELS_CHANGE_EVENT, sync);
    };
  }, []);
  if (!props.onOpenSettings) return null;
  const caps = currentCaps();
  const transcription: TranscriptionAvailability = caps.transcription
    ? 'ready'
    : localAsr ?? 'ready';
  return <CapabilityBannerView
    t={t}
    missing={missingCreativeCaps(caps, transcription)}
    needsLocalModel={transcription === 'missing'}
    onOpenSettings={props.onOpenSettings}
  />;
}
