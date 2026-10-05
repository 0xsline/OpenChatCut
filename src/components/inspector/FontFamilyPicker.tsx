import React, { useState, type CSSProperties } from 'react';
import { useSystemFonts } from '../../fonts/systemFonts';
import { GOOGLE_FONT_CATALOG } from '../../fonts/googleFontCatalog';
import { LOCAL_CJK_FONTS } from '../../fonts/localFonts';
import { useT } from '../../i18n/locale';

export interface FontFamilyPickerProps {
  value: string;
  onChange: (family: string) => void;
  mixed?: boolean;
  style?: CSSProperties;
  showRefresh?: boolean;
  className?: string;
}

export function FontFamilyPicker({
  value,
  onChange,
  mixed = false,
  style,
  showRefresh = true,
  className,
}: FontFamilyPickerProps) {
  const t = useT();
  const { userFonts, systemFonts, customFonts, refresh, addCustomFont } = useSystemFonts();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [customInputOpen, setCustomInputOpen] = useState(false);
  const [customText, setCustomText] = useState('');

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await refresh(true);
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleCustomSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const clean = customText.trim();
    if (clean) {
      addCustomFont(clean);
      onChange(clean);
      setCustomText('');
      setCustomInputOpen(false);
    }
  };

  const currentVal = mixed ? '__mixed' : value || '';

  // Check if current value belongs to an existing option
  const isKnown =
    !value ||
    userFonts.includes(value) ||
    systemFonts.includes(value) ||
    customFonts.includes(value) ||
    GOOGLE_FONT_CATALOG.some((f) => f.family === value) ||
    LOCAL_CJK_FONTS.some((f) => f.family === value);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', width: '100%' }}>
        <select
          aria-label={t('字体')}
          className={className}
          value={currentVal}
          onChange={(e) => {
            const val = e.target.value;
            if (val === '__custom_entry__') {
              setCustomInputOpen(true);
            } else if (val !== '__mixed') {
              onChange(val);
            }
          }}
          style={{
            flex: 1,
            background: 'var(--cc-bg, #1e2430)',
            color: 'var(--cc-text, #f1f5f9)',
            border: '0.5px solid var(--cc-border, #334155)',
            borderRadius: 4,
            padding: '4px 6px',
            fontSize: 12,
            fontFamily: value || 'inherit',
            minWidth: 0,
            ...style,
          }}
        >
          {mixed && <option value="__mixed" disabled>—</option>}
          <option value="">{t('默认系统字体')}</option>

          {/* If the current value is not known yet, render it as an option */}
          {!isKnown && value && (
            <optgroup label={t('当前字体')}>
              <option value={value} style={{ fontFamily: value }}>{value}</option>
            </optgroup>
          )}

          {/* User Installed Fonts (e.g. from ~/Library/Fonts) */}
          {userFonts.length > 0 && (
            <optgroup label={`${t('用户安装字体')} (${userFonts.length})`}>
              {userFonts.map((f) => (
                <option key={`user-${f}`} value={f} style={{ fontFamily: f }}>
                  {f}
                </option>
              ))}
            </optgroup>
          )}

          {/* Custom Entered Fonts */}
          {customFonts.length > 0 && (
            <optgroup label={t('自定义字体')}>
              {customFonts.map((f) => (
                <option key={`custom-${f}`} value={f} style={{ fontFamily: f }}>
                  {f}
                </option>
              ))}
            </optgroup>
          )}

          {/* Google Online Fonts */}
          <optgroup label={`${t('Google 字体')} (${GOOGLE_FONT_CATALOG.length})`}>
            {GOOGLE_FONT_CATALOG.map((f) => (
              <option key={`google-${f.family}`} value={f.family} style={{ fontFamily: f.family }}>
                {f.family}
              </option>
            ))}
          </optgroup>

          {/* Bundled Display Fonts */}
          <optgroup label={`${t('内置字体')} (${LOCAL_CJK_FONTS.length})`}>
            {LOCAL_CJK_FONTS.map((f) => (
              <option key={`cjk-${f.family}`} value={f.family} style={{ fontFamily: f.family }}>
                {f.family}
              </option>
            ))}
          </optgroup>

          {/* System Fonts */}
          {systemFonts.length > 0 && (
            <optgroup label={`${t('系统字体')} (${systemFonts.length})`}>
              {systemFonts.map((f) => (
                <option key={`sys-${f}`} value={f} style={{ fontFamily: f }}>
                  {f}
                </option>
              ))}
            </optgroup>
          )}

          <option value="__custom_entry__">{t('输入自定义字体名称…')}</option>
        </select>

        {showRefresh && (
          <button
            type="button"
            title={t('扫描并刷新已安装字体')}
            onClick={handleRefresh}
            disabled={isRefreshing}
            style={{
              padding: '3px 7px',
              fontSize: 12,
              background: 'transparent',
              color: isRefreshing ? '#94a3b8' : 'var(--cc-text-dim, #94a3b8)',
              border: '0.5px solid var(--cc-border, #334155)',
              borderRadius: 4,
              cursor: isRefreshing ? 'wait' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            {isRefreshing ? '⏳' : '🔄'}
          </button>
        )}
      </div>

      {customInputOpen && (
        <form
          onSubmit={handleCustomSubmit}
          style={{
            display: 'flex',
            gap: 6,
            background: 'rgba(30, 41, 59, 0.5)',
            padding: '4px 6px',
            borderRadius: 4,
            border: '0.5px dashed var(--cc-border, #475569)',
          }}
        >
          <input
            type="text"
            placeholder={t('输入字体名称，例如 JetBrains Mono')}
            aria-label={t('自定义字体名称')}
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            autoFocus
            style={{
              flex: 1,
              background: 'var(--cc-bg, #0f172a)',
              color: 'var(--cc-text, #f8fafc)',
              border: '0.5px solid var(--cc-border, #334155)',
              borderRadius: 3,
              padding: '3px 6px',
              fontSize: 11,
            }}
          />
          <button
            type="submit"
            style={{
              padding: '2px 8px',
              fontSize: 11,
              background: '#2563eb',
              color: '#ffffff',
              border: 'none',
              borderRadius: 3,
              cursor: 'pointer',
            }}
          >
            {t('应用')}
          </button>
          <button
            type="button"
            aria-label={t('取消')}
            onClick={() => setCustomInputOpen(false)}
            style={{
              padding: '2px 6px',
              fontSize: 11,
              background: 'transparent',
              color: '#94a3b8',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            ✕
          </button>
        </form>
      )}
    </div>
  );
}
