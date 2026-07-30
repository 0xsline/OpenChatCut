// The playful film-crew "thinking…" phrases shown while the agent runs
// We cycle one
// per running turn instead of a plain "思考中…".
export const THINKING_PHRASES: string[] = [
  '拉焦中', '推轨道车', '检查片门', '打板儿', '同期声走起', '走位走位',
  'Action!', '卡点卡点', '架灯架灯', '找感觉', '推翻重来', '勘景去',
  '摇一个', '推推推', '跟上跟上', '甩一个', '手持走起', '摇臂升',
  '拉远点', '给个全景', '怼近点', '跳切跳切', '硬切', '叠化过渡',
  '匹配剪辑', '交叉来', '蒙太奇一下', 'L切走起', '接胶片',
];

/** deterministic pick so a given turn keeps one phrase (index varies by seed). */
export function thinkingPhrase(seed: number): string {
  return THINKING_PHRASES[Math.abs(seed) % THINKING_PHRASES.length];
}
