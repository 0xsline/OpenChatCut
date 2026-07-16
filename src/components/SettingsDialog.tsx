import { useEffect, useState } from 'react';
import { theme } from '../theme';
import { Icon } from './icons';
import { applyLiveCaps } from '../agent/capabilities';

// Global settings modal for configuring API keys. Key VALUES are POSTed to the dev server
// (/api/keys), stored server-side + in .env.local (gitignored), and injected server-side —
// they never persist in the browser. GET returns booleans only, so this dialog never
// pre-fills a value: an empty input means "keep unchanged". Clone-specific addition
// (源站无据,自定 — ChatCut is hosted SaaS with backend keys, no user key panel).

interface KeyState { configured: boolean; source: 'env' | 'runtime' | 'none'; }
interface KeyStatusResponse { keys: Record<string, KeyState>; caps: Record<string, boolean>; }

interface FieldDef { name: string; label: string; note?: string; }
interface GroupDef { cap: string; title: string; hint: string; fields: FieldDef[]; }

const GROUPS: GroupDef[] = [
  { cap: 'llm', title: 'Agent 大脑 · Claude 中转', hint: '对话与工具调用的核心，未配置无法对话。', fields: [
    { name: 'LLM_API_KEY', label: 'API Key' },
    { name: 'LLM_BASE_URL', label: 'Base URL（中转站，留空用默认）', note: '改动需重启 dev server 生效' },
  ] },
  { cap: 'image', title: '生图', hint: 'submit_image · 文生图 / 图生图，二选一即可。', fields: [
    { name: 'IMAGE_API_KEY', label: 'OpenAI 兼容图像 Key（gpt-image）' },
    { name: 'GEMINI_API_KEY', label: 'Gemini Key（Nano Banana）' },
  ] },
  { cap: 'voice', title: '配音 / TTS', hint: 'submit_voice · 文字转语音，ElevenLabs 或豆包二选一。', fields: [
    { name: 'ELEVENLABS_API_KEY', label: 'ElevenLabs Key（也用于音效生成）' },
    { name: 'DOUBAO_TTS_APP_ID', label: '豆包 TTS App ID' },
    { name: 'DOUBAO_TTS_ACCESS_KEY', label: '豆包 TTS Access Key' },
  ] },
  { cap: 'video', title: '生视频', hint: 'submit_video · 文 / 图生视频，二选一即可。', fields: [
    { name: 'SEEDANCE_API_KEY', label: 'Seedance（豆包）Key' },
    { name: 'KLING_API_KEY', label: '可灵 Kling Key' },
  ] },
  { cap: 'music', title: '生音乐', hint: 'submit_music · 文字生成配乐。', fields: [
    { name: 'MUREKA_API_KEY', label: 'Mureka Key' },
  ] },
  { cap: 'stock', title: '在线图库', hint: 'search_stock_media · 搜索可商用图片 / 视频素材。', fields: [
    { name: 'PEXELS_API_KEY', label: 'Pexels Key' },
    { name: 'PIXABAY_API_KEY', label: 'Pixabay Key' },
  ] },
  { cap: 'transcription', title: '转写 / 口播剪辑', hint: 'transcribe_track · 词级字幕、清口水、删词。', fields: [
    { name: 'ASSEMBLYAI_API_KEY', label: 'AssemblyAI Key' },
  ] },
  { cap: 'sandbox', title: '沙箱执行', hint: 'run_code · ffmpeg / node / python 媒体探测与处理。', fields: [
    { name: 'E2B_API_KEY', label: 'E2B Key' },
  ] },
  { cap: 'web', title: '网页抓取', hint: 'web_browser · 抓取网页内容供 Agent 参考。', fields: [
    { name: 'FIRECRAWL_API_KEY', label: 'Firecrawl Key' },
  ] },
];

const ON = '#4caf7d';

function groupOn(status: KeyStatusResponse | null, g: GroupDef): boolean {
  if (!status) return false;
  if (g.cap === 'llm') return Boolean(status.keys.LLM_API_KEY?.configured);
  return Boolean(status.caps[g.cap]);
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<KeyStatusResponse | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/keys')
      .then((r) => r.json() as Promise<KeyStatusResponse>)
      .then((d) => { if (alive) setStatus(d); })
      .catch(() => { if (alive) setError('无法读取配置（dev 服务未就绪？）'); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const dirty = Object.values(values).some((v) => v.trim() !== '');

  const save = async () => {
    const patch: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) if (v.trim() !== '') patch[k] = v.trim();
    if (Object.keys(patch).length === 0) { setMsg('没有改动'); return; }
    setSaving(true); setError(null); setMsg(null);
    try {
      const res = await fetch('/api/keys', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => ({})) as Partial<KeyStatusResponse> & { error?: string };
      if (!res.ok) throw new Error(body.error || `保存失败 (${res.status})`);
      const next = body as KeyStatusResponse;
      setStatus(next);
      applyLiveCaps(next.caps);
      setValues({});
      setMsg('已保存 · 工具即时生效，Agent 下一条消息即可感知');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={overlay} onMouseDown={onClose}>
      <div style={panel} onMouseDown={(e) => e.stopPropagation()}>
        <header style={head}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: theme.accent, display: 'inline-flex' }}><Icon name="sliders" size={15} /></span>
            <b style={{ fontSize: 14 }}>设置 · API 密钥</b>
          </div>
          <button onClick={onClose} title="关闭 (Esc)" style={iconBtn}><Icon name="x" size={15} /></button>
        </header>

        <p style={intro}>
          密钥仅保存在本机 <code style={code}>.env.local</code>（已 gitignore），经服务端注入，<b>不进浏览器</b>。
          留空的输入框表示保持原值不变。
        </p>

        <div style={{ overflowY: 'auto', flex: 1, padding: '2px 20px 8px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {GROUPS.map((g) => {
            const on = groupOn(status, g);
            return (
              <section key={g.cap} style={group}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: on ? ON : theme.borderLight, flex: '0 0 auto' }} />
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{g.title}</span>
                  <span style={{ fontSize: 11, color: on ? ON : theme.textDim }}>{on ? '已配置' : '未配置'}</span>
                </div>
                <div style={{ fontSize: 11.5, color: theme.textDim, marginBottom: 8, paddingLeft: 15 }}>{g.hint}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7, paddingLeft: 15 }}>
                  {g.fields.map((f) => {
                    const st = status?.keys[f.name];
                    return (
                      <label key={f.name} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                        <span style={{ fontSize: 11.5, color: theme.text, display: 'flex', gap: 6, alignItems: 'center' }}>
                          {f.label}
                          {st?.configured && <span style={sourceTag}>{st.source === 'env' ? '.env.local' : '本次设置'}</span>}
                        </span>
                        <input
                          type={reveal ? 'text' : 'password'}
                          autoComplete="off" spellCheck={false}
                          value={values[f.name] ?? ''}
                          onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                          placeholder={st?.configured ? '已配置 · 留空保持不变' : '未配置 · 粘贴以启用'}
                          style={input}
                        />
                        {f.note && <span style={{ fontSize: 10.5, color: theme.textDim }}>{f.note}</span>}
                      </label>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>

        <footer style={foot}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: theme.textDim, cursor: 'pointer', userSelect: 'none' }}>
            <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} />
            显示明文
          </label>
          <div style={{ flex: 1, minWidth: 0, textAlign: 'right', fontSize: 11.5, color: error ? '#f77' : ON, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {error ?? msg ?? ''}
          </div>
          <button onClick={onClose} style={btnGhost}>关闭</button>
          <button onClick={save} disabled={saving || !dirty} style={{ ...btnPrimary, opacity: saving || !dirty ? 0.5 : 1, cursor: saving || !dirty ? 'default' : 'pointer' }}>
            {saving ? '保存中…' : '保存'}
          </button>
        </footer>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.62)', display: 'grid', placeItems: 'center',
  zIndex: 200, padding: 24, fontFamily: 'system-ui, -apple-system, sans-serif',
};
const panel: React.CSSProperties = {
  width: 'min(560px, 100%)', maxHeight: '86vh', display: 'flex', flexDirection: 'column',
  background: theme.panel, color: theme.text, border: `1px solid ${theme.border}`, borderRadius: 12,
  boxShadow: '0 24px 64px rgba(0,0,0,0.5)', overflow: 'hidden',
};
const head: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '13px 16px 13px 20px', borderBottom: `1px solid ${theme.border}`,
};
const intro: React.CSSProperties = { margin: 0, padding: '12px 20px', fontSize: 12, lineHeight: 1.6, color: theme.textDim };
const group: React.CSSProperties = { background: theme.bg, border: `1px solid ${theme.border}`, borderRadius: 9, padding: '11px 13px' };
const input: React.CSSProperties = {
  font: 'inherit', fontSize: 12.5, background: theme.panelAlt, color: theme.text,
  border: `1px solid ${theme.border}`, borderRadius: 6, padding: '6px 9px', width: '100%', outline: 'none',
};
const sourceTag: React.CSSProperties = { fontSize: 10, color: theme.textDim, border: `1px solid ${theme.border}`, borderRadius: 4, padding: '0 5px' };
const foot: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px 12px 20px', borderTop: `1px solid ${theme.border}`, background: theme.panel,
};
const iconBtn: React.CSSProperties = { background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', padding: 4, borderRadius: 5, display: 'inline-flex' };
const btnGhost: React.CSSProperties = { font: 'inherit', fontSize: 12.5, background: 'transparent', color: theme.text, border: `1px solid ${theme.border}`, borderRadius: 7, padding: '6px 13px', cursor: 'pointer' };
const btnPrimary: React.CSSProperties = { font: 'inherit', fontSize: 12.5, fontWeight: 600, background: theme.accent, color: '#fff', border: 'none', borderRadius: 7, padding: '6px 16px' };
const code: React.CSSProperties = { fontFamily: 'ui-monospace, monospace', fontSize: 11, background: theme.panelAlt, padding: '1px 5px', borderRadius: 4 };
