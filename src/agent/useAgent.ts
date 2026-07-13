import { useCallback, useRef, useState } from 'react';
import type { AgentContext } from './context';
import { initialMessages, runAgent, type LLMMessage } from './runtime';

export interface DisplayMessage {
  role: 'user' | 'assistant' | 'tool' | 'error';
  text: string;
  tool?: { name: string; args: unknown; result: unknown };
}

export function useAgent(ctx: AgentContext) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [running, setRunning] = useState(false);
  const llmRef = useRef<LLMMessage[]>(initialMessages());
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx; // always use the latest editor context

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || running) return;
      setMessages((m) => [...m, { role: 'user', text: trimmed }]);
      llmRef.current.push({ role: 'user', content: trimmed });
      setRunning(true);
      try {
        llmRef.current = await runAgent(llmRef.current, ctxRef.current, (ev) => {
          if (ev.type === 'text-start') {
            setMessages((m) => [...m, { role: 'assistant', text: '' }]);
          } else if (ev.type === 'text-delta') {
            setMessages((m) => {
              const last = m[m.length - 1];
              if (last?.role === 'assistant') return [...m.slice(0, -1), { ...last, text: last.text + ev.delta }];
              return [...m, { role: 'assistant', text: ev.delta }];
            });
          } else if (ev.type === 'tool') {
            setMessages((m) => [...m, { role: 'tool', text: '', tool: { name: ev.name, args: ev.args, result: ev.result } }]);
          } else {
            setMessages((m) => [...m, { role: 'error', text: ev.message }]);
          }
        });
      } finally {
        setRunning(false);
      }
    },
    [running],
  );

  return { messages, running, send };
}
