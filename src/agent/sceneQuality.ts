// Pure advisory review for multi-scene plans. The report has no runtime enforcement role.

export interface SceneLike {
  type: string;
  description?: string;
  /** Why this frame exists. */
  shotIntent?: string;
  /** What information or story beat this frame communicates. */
  informationRole?: string;
}

export type SceneFindingSeverity = 'high' | 'medium' | 'low';
export type SceneFindingDimension =
  | 'repetition'
  | 'decorative_visuals'
  | 'typography_overreliance'
  | 'generic_language';

export interface SceneFinding {
  severity: SceneFindingSeverity;
  dimension: SceneFindingDimension;
  /** One-based scene numbers affected by this finding. */
  scenes: number[];
  message: string;
}

export interface SceneQualityReport {
  /** Advisory risk score from 0–5. It is normalized by scene count and finding severity. */
  score: number;
  verdict: 'strong' | 'acceptable' | 'revise';
  findings: SceneFinding[];
  advisory: true;
}

const GENERIC_PHRASES = [
  '美丽的', '炫酷', '惊艳', '大气', '高端', '专业感', '现代感', '震撼',
  'a beautiful', 'stunning', 'amazing', 'incredible', 'modern', 'sleek',
  'cutting-edge', 'professional', 'dynamic', 'vibrant', 'breathtaking',
] as const;

const STATIC_TYPES: Record<string, true> = {
  text_card: true,
  text: true,
  stat_card: true,
  stat: true,
  quote: true,
  title: true,
  chart: true,
  diagram: true,
  list: true,
};

const SEVERITY_WEIGHT: Record<SceneFindingSeverity, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

function normalizeType(type: string): string {
  return type.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function normalizeText(text: string | undefined): string {
  return (text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}


function sceneRangeMessage(scenes: readonly number[]): string {
  return scenes.map((scene) => String(scene)).join(', ');
}

function repetitionFindings(scenes: readonly SceneLike[]): SceneFinding[] {
  const findings: SceneFinding[] = [];
  const types = scenes.map((scene) => normalizeType(scene.type));
  let runStart = 0;
  for (let index = 1; index <= types.length; index += 1) {
    if (index < types.length && types[index] === types[runStart]) continue;
    const runScenes = Array.from({ length: index - runStart }, (_, offset) => runStart + offset + 1);
    if (runScenes.length >= 3) {
      findings.push({
        severity: 'medium',
        dimension: 'repetition',
        scenes: runScenes,
        message: `场景 ${sceneRangeMessage(runScenes)} 连续使用同一类型「${types[runStart]}」；建议改变镜头类型或构图。`,
      });
    }
    runStart = index;
  }

  const descriptionScenes = new Map<string, number[]>();
  scenes.forEach((scene, index) => {
    const description = normalizeText(scene.description);
    if (!description) return;
    descriptionScenes.set(description, [...(descriptionScenes.get(description) ?? []), index + 1]);
  });
  for (const [description, affected] of descriptionScenes) {
    if (affected.length < 3) continue;
    findings.push({
      severity: 'medium',
      dimension: 'repetition',
      scenes: affected,
      message: `场景 ${sceneRangeMessage(affected)} 重复同一画面描述「${description.slice(0, 80)}」；请为每个镜头指定不同内容或动作。`,
    });
  }
  return findings;
}

/**
 * Review a scene list for slideshow-like risks. The result is advisory only:
 * callers may use it to revise a plan, but it never authorizes or blocks generation.
 */
export function reviewScenePlan(scenes: readonly SceneLike[]): SceneQualityReport {
  if (!scenes.length) {
    return {
      score: 5,
      verdict: 'revise',
      advisory: true,
      findings: [{
        severity: 'high',
        dimension: 'decorative_visuals',
        scenes: [],
        message: '场景列表为空，没有可供审阅的分镜。',
      }],
    };
  }

  const findings = repetitionFindings(scenes);
  const purposeless = scenes
    .map((scene, index) => ({ scene, number: index + 1 }))
    .filter(({ scene }) => !scene.shotIntent?.trim() && !scene.informationRole?.trim())
    .map(({ number }) => number);
  if (purposeless.length) {
    findings.push({
      severity: purposeless.length / scenes.length >= 0.3 ? 'medium' : 'low',
      dimension: 'decorative_visuals',
      scenes: purposeless,
      message: `场景 ${sceneRangeMessage(purposeless)} 缺少非空 shotIntent/informationRole；请说明镜头的叙事或信息职责。`,
    });
  }

  const staticScenes = scenes
    .map((scene, index) => ({ type: normalizeType(scene.type), number: index + 1 }))
    .filter(({ type }) => STATIC_TYPES[type])
    .map(({ number }) => number);
  if (staticScenes.length / scenes.length > 0.6) {
    findings.push({
      severity: 'medium',
      dimension: 'typography_overreliance',
      scenes: staticScenes,
      message: `${staticScenes.length}/${scenes.length} 个场景是静态卡片或图表；建议加入实拍、生成视频或有动作的场景。`,
    });
  }

  const genericScenes = new Map<string, number[]>();
  scenes.forEach((scene, index) => {
    const description = normalizeText(scene.description);
    for (const phrase of GENERIC_PHRASES) {
      if (!description.includes(phrase)) continue;
      genericScenes.set(phrase, [...(genericScenes.get(phrase) ?? []), index + 1]);
    }
  });
  for (const [phrase, affected] of genericScenes) {
    findings.push({
      severity: 'low',
      dimension: 'generic_language',
      scenes: affected,
      message: `场景 ${sceneRangeMessage(affected)} 使用泛化措辞「${phrase}」；改写为具体主体、构图、光线、动作或信息。`,
    });
  }

  const riskMass = findings.reduce(
    (sum, finding) => sum + SEVERITY_WEIGHT[finding.severity] * Math.max(1, finding.scenes.length),
    0,
  );
  const score = Math.min(5, Math.round((riskMass / scenes.length) * 10) / 10);
  const verdict = score >= 3 ? 'revise' : score >= 1.5 ? 'acceptable' : 'strong';
  return { score, verdict, findings, advisory: true };
}
