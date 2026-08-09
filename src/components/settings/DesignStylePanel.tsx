import { getLocale } from '../../i18n/locale';
import type { DesignStyle } from '../../editor/types';
import {
  DesignStylePanelBody,
  DesignStylePanelFooter,
  DesignStylePanelFrame,
  DesignStylePanelHeader,
} from './DesignStylePanelSections';
import { useDesignStylePanelModel } from './useDesignStylePanelModel';

interface DesignStylePanelProps {
  style: DesignStyle | undefined;
  onApply: (style: DesignStyle | null) => void;
  onClose: () => void;
}

/** Design-style editor with a live draft preview and one-shot project apply. */
export function DesignStylePanel({ style, onApply, onClose }: DesignStylePanelProps) {
  const locale = getLocale();
  const model = useDesignStylePanelModel(style);
  return <DesignStylePanelFrame onClose={onClose}>
    <DesignStylePanelHeader primary={model.preview.primary} onClose={onClose} />
    <DesignStylePanelBody model={model} locale={locale} />
    <DesignStylePanelFooter model={model} onApply={onApply} onClose={onClose} />
  </DesignStylePanelFrame>;
}
