export { SCENE_QUALITY_TOOL_NAMES, SCENE_QUALITY_TOOL_SCHEMAS } from './schemas/scene-quality-tools';
import { reviewScenePlan } from '../sceneQuality';
import type { SceneLike } from '../sceneQuality';
import type { AgentContext } from '../context';

type Args = Record<string, unknown>;

export async function execSceneQualityTool(
  name: string,
  args: Args,
  _ctx: AgentContext,
): Promise<unknown> {
  if (name !== 'review_scene_plan') return { error: `unknown tool ${name}` };
  if (!Array.isArray(args.scenes) || !args.scenes.length) {
    return { error: 'review_scene_plan requires a non-empty scenes array' };
  }
  const scenes: SceneLike[] = [];
  for (const [index, raw] of args.scenes.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: `scenes[${index}] must be an object` };
    }
    const scene = raw as Record<string, unknown>;
    if (typeof scene.type !== 'string' || !scene.type.trim()) {
      return { error: `scenes[${index}].type must be a non-empty string` };
    }
    scenes.push({
      type: scene.type,
      description: typeof scene.description === 'string' ? scene.description : undefined,
      shotIntent: typeof scene.shotIntent === 'string' ? scene.shotIntent : undefined,
      informationRole: typeof scene.informationRole === 'string' ? scene.informationRole : undefined,
    });
  }
  return { ok: true, ...reviewScenePlan(scenes) };
}
