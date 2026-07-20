import type { CSSProperties } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { theme } from '../../theme';

// Assistant chat markdown via react-markdown + remark-gfm (GFM tables, strikethrough,
// autolinks). react-markdown renders NO raw HTML by default and sanitizes URLs, so it's
// safe for untrusted LLM output. Visual styling lives in index.css under `.cc-md`.

interface MarkdownProps {
  text: string;
  style?: CSSProperties;
}

export function Markdown({ text, style }: MarkdownProps) {
  if (!text) return null;
  return (
    <div className="cc-md" style={{ color: theme.text, wordBreak: 'break-word', lineHeight: 1.6, ...style }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">{children}</a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
