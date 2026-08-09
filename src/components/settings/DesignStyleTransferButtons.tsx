import { useRef, useState, type CSSProperties } from 'react';
import type { DesignStyle } from '../../editor/types';
import { useT } from '../../i18n/locale';
import { sanitizeFileName } from '../../media/fileName';
import {
  buildDesignStyleRecipe,
  parseDesignStyleRecipe,
} from '../../persist/designStyleTransfer';
import { saveOwnedStyle, type OwnedStyle } from '../../persist/ownedStyleStore';
import { theme } from '../../theme';

const MAX_FILE_BYTES = 256 * 1024;

interface DesignStyleTransferButtonsProps {
  name?: string;
  style: DesignStyle;
  scenarios?: string[];
  thumbnailUrl?: string;
  onImported: (entry: OwnedStyle) => void;
}

export function DesignStyleTransferButtons(props: DesignStyleTransferButtonsProps) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');

  const exportRecipe = () => {
    try {
      const recipe = buildDesignStyleRecipe(props.name || t('编辑配方'), props.style, {
        scenarios: props.scenarios,
        thumbnailUrl: props.thumbnailUrl,
      });
      downloadRecipe(recipe.name, JSON.stringify(recipe, null, 2));
      setError('');
    } catch (cause) {
      setError(t(messageOf(cause, '配方导出失败')));
    }
  };

  const importRecipe = async (file: File | undefined) => {
    if (!file) return;
    try {
      if (file.size > MAX_FILE_BYTES) throw new Error(t('配方文件过大'));
      const recipe = parseDesignStyleRecipe(await file.text());
      const saved = await saveOwnedStyle(recipe.name, recipe.style, recipe);
      props.onImported(saved);
      setError('');
    } catch (cause) {
      setError(t(messageOf(cause, '配方导入失败')));
    } finally {
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <input ref={inputRef} type="file" accept=".json,application/json" hidden
        onChange={(event) => void importRecipe(event.target.files?.[0])} />
      <button type="button" onClick={() => inputRef.current?.click()} style={button}>{t('导入配方')}</button>
      <button type="button" onClick={exportRecipe} style={button}>{t('导出配方')}</button>
      {error && <span role="alert" title={error} style={errorText}>{error}</span>}
    </div>
  );
}

function downloadRecipe(name: string, json: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${sanitizeFileName(name, 'editing-recipe')}.ccstyle.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

const button: CSSProperties = {
  border: `0.5px solid ${theme.border}`, borderRadius: 5, padding: '5px 9px',
  color: theme.textDim, background: 'transparent', fontSize: 11, cursor: 'pointer',
};
const errorText: CSSProperties = {
  color: theme.danger, fontSize: 10, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
