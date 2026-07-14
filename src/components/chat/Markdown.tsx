import type { CSSProperties, ReactNode } from 'react';
import { theme } from '../../theme';

// Lightweight markdown for assistant chat bubbles — no extra deps.
// Supports: paragraphs, # headings, -/* lists, 1. lists, fenced code,
// inline `code`, **bold**, *italic*, [links](url). No raw HTML.

interface MarkdownProps {
  text: string;
  style?: CSSProperties;
}

const codeInline: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '0.9em',
  background: '#2a2a2a',
  color: '#e8c07d',
  padding: '1px 5px',
  borderRadius: 4,
  border: '1px solid #3a3a3a',
};

/** inline: code, bold, italic, links (code first so * inside is not styled) */
function renderInline(raw: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(raw))) {
    if (m.index > last) {
      nodes.push(<span key={`${keyPrefix}-t${i++}`}>{raw.slice(last, m.index)}</span>);
    }
    const tok = m[0];
    if (tok.startsWith('`')) {
      nodes.push(
        <code key={`${keyPrefix}-c${i++}`} style={codeInline}>{tok.slice(1, -1)}</code>,
      );
    } else if (tok.startsWith('**')) {
      nodes.push(
        <strong key={`${keyPrefix}-b${i++}`} style={{ fontWeight: 600, color: '#eee' }}>
          {renderInline(tok.slice(2, -2), `${keyPrefix}-bi${i}`)}
        </strong>,
      );
    } else if (tok.startsWith('*')) {
      nodes.push(
        <em key={`${keyPrefix}-e${i++}`} style={{ fontStyle: 'italic', color: '#ddd' }}>
          {tok.slice(1, -1)}
        </em>,
      );
    } else if (tok.startsWith('[')) {
      const lm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (lm) {
        const href = lm[2];
        const safe = /^(https?:|mailto:|\/)/i.test(href) ? href : '#';
        nodes.push(
          <a key={`${keyPrefix}-a${i++}`} href={safe} target="_blank" rel="noreferrer"
            style={{ color: theme.accent, textDecoration: 'underline' }}>{lm[1]}</a>,
        );
      } else {
        nodes.push(<span key={`${keyPrefix}-x${i++}`}>{tok}</span>);
      }
    }
    last = m.index + tok.length;
  }
  if (last < raw.length) nodes.push(<span key={`${keyPrefix}-t${i++}`}>{raw.slice(last)}</span>);
  return nodes.length ? nodes : [<span key={`${keyPrefix}-empty`}>{raw}</span>];
}

type Block =
  | { type: 'p'; text: string }
  | { type: 'h'; level: number; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'hr' };

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^```([\w-]*)\s*$/);
    if (fence) {
      const lang = fence[1] || '';
      i += 1;
      const body: string[] = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: 'code', lang, text: body.join('\n') });
      continue;
    }

    if (/^---+\s*$/.test(line) || /^\*\*\*+\s*$/.test(line)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (h) {
      blocks.push({ type: 'h', level: h[1].length, text: h[2].trim() });
      i += 1;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const um = lines[i].match(/^[-*]\s+(.+)$/);
        if (!um) break;
        items.push(um[1]);
        i += 1;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const om = lines[i].match(/^\d+\.\s+(.+)$/);
        if (!om) break;
        items.push(om[1]);
        i += 1;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const para: string[] = [line];
    i += 1;
    while (i < lines.length) {
      const n = lines[i];
      if (!n.trim()) break;
      if (/^#{1,4}\s/.test(n) || /^[-*]\s+/.test(n) || /^\d+\.\s+/.test(n) || /^```/.test(n) || /^---+\s*$/.test(n)) break;
      para.push(n);
      i += 1;
    }
    blocks.push({ type: 'p', text: para.join('\n') });
  }
  return blocks;
}

export function Markdown({ text, style }: MarkdownProps) {
  if (!text) return null;
  const blocks = parseBlocks(text);
  const hSize = [0, 16, 15, 14, 13];

  return (
    <div className="cc-md" style={{ color: theme.text, wordBreak: 'break-word', lineHeight: 1.6, ...style }}>
      {blocks.map((b, idx) => {
        if (b.type === 'p') {
          return (
            <p key={idx} style={{ margin: '0 0 10px', whiteSpace: 'pre-wrap' }}>
              {renderInline(b.text, `p${idx}`)}
            </p>
          );
        }
        if (b.type === 'h') {
          return (
            <div key={idx} style={{
              margin: idx === 0 ? '0 0 8px' : '12px 0 8px',
              fontWeight: 600, color: '#eee',
              fontSize: hSize[b.level] ?? 13, lineHeight: 1.35,
            }}>
              {renderInline(b.text, `h${idx}`)}
            </div>
          );
        }
        if (b.type === 'ul') {
          return (
            <ul key={idx} style={{ margin: '0 0 10px', paddingLeft: 20 }}>
              {b.items.map((it, j) => (
                <li key={j} style={{ marginBottom: 4 }}>{renderInline(it, `ul${idx}-${j}`)}</li>
              ))}
            </ul>
          );
        }
        if (b.type === 'ol') {
          return (
            <ol key={idx} style={{ margin: '0 0 10px', paddingLeft: 22 }}>
              {b.items.map((it, j) => (
                <li key={j} style={{ marginBottom: 4 }}>{renderInline(it, `ol${idx}-${j}`)}</li>
              ))}
            </ol>
          );
        }
        if (b.type === 'code') {
          return (
            <pre key={idx} style={{
              margin: '0 0 10px', padding: '10px 12px', borderRadius: 8,
              background: '#1a1a1a', border: '1px solid #333', overflowX: 'auto',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 12, lineHeight: 1.45, color: '#d8d8d8',
            }}>
              <code>{b.text}</code>
            </pre>
          );
        }
        if (b.type === 'hr') {
          return <hr key={idx} style={{ border: 0, borderTop: '1px solid #333', margin: '12px 0' }} />;
        }
        return null;
      })}
    </div>
  );
}
