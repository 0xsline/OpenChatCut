import React, { useState, type CSSProperties } from 'react';
import { useSystemFonts } from '../../fonts/systemFonts';
import { GOOGLE_FONT_CATALOG } from '../../fonts/googleFontCatalog';
import { LOCAL_CJK_FONTS } from '../../fonts/localFonts';

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
          <option value="">Default System Font (Geist / System UI)</option>

          {/* If the current value is not known yet, render it as an option */}
          {!isKnown && value && (
            <optgroup label="Current Font">
              <option value={value} style={{ fontFamily: value }}>{value}</option>
            </optgroup>
          )}

          {/* User Installed Fonts (e.g. from ~/Library/Fonts) */}
          {userFonts.length > 0 && (
            <optgroup label={`Installed User Fonts (${userFonts.length})`}>
              {userFonts.map((f) => (
                <option key={`user-${f}`} value={f} style={{ fontFamily: f }}>
                  {f}
                </option>
              ))}
            </optgroup>
          )}

          {/* Custom Entered Fonts */}
          {customFonts.length > 0 && (
            <optgroup label="Custom Fonts">
              {customFonts.map((f) => (
                <option key={`custom-${f}`} value={f} style={{ fontFamily: f }}>
                  {f}
                </option>
              ))}
            </optgroup>
          )}

          {/* Google Online Fonts */}
          <optgroup label={`Google Fonts (${GOOGLE_FONT_CATALOG.length})`}>
            {GOOGLE_FONT_CATALOG.map((f) => (
              <option key={`google-${f.family}`} value={f.family} style={{ fontFamily: f.family }}>
                {f.family}
              </option>
            ))}
          </optgroup>

          {/* Bundled Display Fonts */}
          <optgroup label={`Bundled Display Fonts (${LOCAL_CJK_FONTS.length})`}>
            {LOCAL_CJK_FONTS.map((f) => (
              <option key={`cjk-${f.family}`} value={f.family} style={{ fontFamily: f.family }}>
                {f.family}
              </option>
            ))}
          </optgroup>

          {/* System Fonts */}
          {systemFonts.length > 0 && (
            <optgroup label={`System Fonts (${systemFonts.length})`}>
              {systemFonts.slice(0, 100).map((f) => (
                <option key={`sys-${f}`} value={f} style={{ fontFamily: f }}>
                  {f}
                </option>
              ))}
              {systemFonts.length > 100 && (
                <option value="__more_sys__" disabled>
                  {`... and ${systemFonts.length - 100} more system fonts`}
                </option>
              )}
            </optgroup>
          )}

          <option value="__custom_entry__">✍️ + Enter Custom Font Name...</option>
        </select>

        {showRefresh && (
          <button
            type="button"
            title="Scan & refresh installed fonts"
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
            placeholder="e.g. JetBrains Mono, Nexa, etc..."
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
            Apply
          </button>
          <button
            type="button"
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
