import { useCallback, useEffect, useRef, useState } from 'react';
import type { LLMMessage } from './runtime';
import { estimateContextTokens, type AgentContextUsage } from './context-compaction';
import {
  getAgentModelSnapshot,
  subscribeAgentModels,
  type AgentModelChoice,
} from './model-selection';

interface MessageRef {
  readonly current: readonly LLMMessage[];
}

function estimatedUsage(messages: readonly LLMMessage[]): AgentContextUsage | null {
  const snapshot = getAgentModelSnapshot();
  const active = snapshot.choices.find((choice) => choice.id === snapshot.activeId);
  if (!active) return null;
  const contextWindow = active.capabilities.contextWindowTokens;
  return {
    inputTokens: estimateContextTokens(messages),
    contextWindowEstimated: contextWindow.estimated,
    contextWindowTokens: contextWindow.value,
    messageCount: messages.length,
    isEstimated: true,
    modelId: active.id,
    compacted: false,
  };
}

export function usageNeedsChoiceRefresh(
  current: AgentContextUsage | null,
  active: AgentModelChoice,
): boolean {
  if (current?.modelId !== active.id) return true;
  const contextWindow = active.capabilities.contextWindowTokens;
  if (active.backend === 'codex'
    && current.isEstimated === false
    && current.contextWindowEstimated === false
    && contextWindow.source !== 'settings-override') return false;
  return current.contextWindowTokens !== contextWindow.value
    || current.contextWindowEstimated !== contextWindow.estimated;
}

export function useAgentContextUsage(messages: MessageRef) {
  const [usage, setUsage] = useState<AgentContextUsage | null>(null);
  const usageRef = useRef<AgentContextUsage | null>(null);
  const replace = useCallback((next: AgentContextUsage | null) => {
    usageRef.current = next;
    setUsage(next);
  }, []);
  const refreshEstimate = useCallback(() => {
    replace(estimatedUsage(messages.current));
  }, [messages, replace]);
  useEffect(() => subscribeAgentModels(() => {
    const snapshot = getAgentModelSnapshot();
    const active = snapshot.choices.find((choice) => choice.id === snapshot.activeId);
    const current = usageRef.current;
    if (!active || !usageNeedsChoiceRefresh(current, active)) return;
    refreshEstimate();
  }), [refreshEstimate]);
  return { usage, usageRef, replace, refreshEstimate };
}
