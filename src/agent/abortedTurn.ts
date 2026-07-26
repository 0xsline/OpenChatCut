// 中止一轮之后的会话收尾判定,单独成文件是为了能被 Node 验证脚本直接导入
// (runtime.ts 会连带拉进整张工具图,里面有 GLSL 之类 Node 加载不了的资源)。
import type { ModelMessage } from 'ai';

/** 会话里已发出但还没有结果的工具调用(中止时用来补收尾)。exported for verify。 */
export function unresolvedToolCalls(
  messages: readonly ModelMessage[],
): Array<{ toolCallId: string; toolName: string }> {
  const pending = new Map<string, string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === 'tool-call') pending.set(part.toolCallId, part.toolName);
      else if (part.type === 'tool-result') pending.delete(part.toolCallId);
    }
  }
  return [...pending].map(([toolCallId, toolName]) => ({ toolCallId, toolName }));
}
