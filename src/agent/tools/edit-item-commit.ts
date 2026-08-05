import type { AgentContext } from '../context';
import type { ClipEffect, TimelineItem, TransitionType, ZoomEffect } from '../../editor/types';
import { applyGeneric } from './edit-item-generic';
import { transitionAssetId } from './library-catalog';
import { describeClip, findItem, type OpResult } from './edit-item-shared';

export function commitPlan(ctx: AgentContext, plan: OpResult, ripple = false): OpResult {
  if (!plan.ok || plan.error) return plan;
  const name = String(plan.plan);
  if (['setZoom', 'addEffect', 'updateEffect', 'setEffects', 'clearZoom'].includes(name)) {
    return commitVisualPlan(ctx, plan);
  }
  if (['addTransition', 'setTransition', 'removeTransition'].includes(name)) {
    return commitTransitionPlan(ctx, plan);
  }
  if (name === 'addAudio') return commitAudioPlan(ctx, plan, ripple);
  if (name === 'addMg') return commitMotionGraphicPlan(ctx, plan, ripple);
  if (name === 'addMedia') return commitMediaPlan(ctx, plan);
  if (name === 'addText') return commitTextPlan(ctx, plan, ripple);
  if (name === 'addSolid') return commitSolidPlan(ctx, plan, ripple);
  if (name === 'genericUpdate' || name === 'genericDelete' || name === 'slip') {
    return applyGeneric(plan, ctx.commands) ?? { error: `unknown plan ${name}` };
  }
  return { error: `unknown plan ${name}` };
}

function commitVisualPlan(ctx: AgentContext, plan: OpResult): OpResult {
  if (plan.plan === 'setZoom') return commitZoom(ctx, plan);
  if (plan.plan === 'addEffect' || plan.plan === 'updateEffect') {
    const item = findItem(ctx.getState().items, plan.targetItemId)!;
    const effects = plan.plan === 'addEffect'
      ? [...(item.effects ?? []), plan.effect as ClipEffect]
      : (item.effects ?? []).map((effect, index) =>
        index === Number(plan.index) ? plan.effect as ClipEffect : effect);
    ctx.commands.setItemEffects(item.id, effects);
    return { ok: true, kind: 'effect', ...describeClip({ ...item, effects }) };
  }
  if (plan.plan === 'setEffects') {
    ctx.commands.setItemEffects(String(plan.targetItemId), plan.effects as ClipEffect[]);
    return { ok: true, deleted: 'effect', itemId: plan.targetItemId, remaining: plan.remaining };
  }
  ctx.commands.setItemZoom(String(plan.targetItemId), null);
  return { ok: true, deleted: 'zoom', itemId: plan.targetItemId };
}

function commitZoom(ctx: AgentContext, plan: OpResult): OpResult {
  const zoom = plan.zoom as ZoomEffect;
  ctx.commands.setItemZoom(String(plan.targetItemId), zoom);
  const current = findItem(ctx.getState().items, plan.targetItemId)
    ?? { id: String(plan.targetItemId) } as TimelineItem;
  return {
    ok: true,
    kind: 'zoom',
    ...describeClip({ ...current, zoom }),
    applied: zoom,
  };
}

function commitTransitionPlan(ctx: AgentContext, plan: OpResult): OpResult {
  if (plan.plan === 'setTransition') {
    ctx.commands.setTransition(
      String(plan.id),
      plan.patch as Partial<{ type: TransitionType; durationInFrames: number }>,
    );
    return { ok: true, kind: 'transition', id: plan.id, patch: plan.patch };
  }
  if (plan.plan === 'removeTransition') {
    ctx.commands.removeTransition(String(plan.id));
    return { ok: true, deleted: 'transition', id: plan.id };
  }
  const id = ctx.commands.addTransition(
    String(plan.incomingItemId),
    plan.type as TransitionType,
    plan.durationInFrames as number | undefined,
    plan.custom as { frag: string; uniforms: Record<string, number>; label: string } | undefined,
  );
  return {
    ok: true,
    kind: 'transition',
    transition: {
      id,
      type: plan.type,
      assetId: plan.assetId ?? transitionAssetId(plan.type as TransitionType),
      durationInFrames: plan.durationInFrames,
      outgoingItemId: plan.outgoingItemId,
      incomingItemId: plan.incomingItemId,
    },
  };
}

function commitAudioPlan(ctx: AgentContext, plan: OpResult, ripple: boolean): OpResult {
  ctx.commands.addAudio(
    {
      id: `sfx_${plan.sfxId}`,
      name: String(plan.name),
      category: 'sfx',
      src: String(plan.src),
      durationInFrames: Number(plan.durationInFrames),
    },
    {
      track: plan.track as string | undefined,
      startFrame: plan.startFrame as number | undefined,
      ripple,
    },
  );
  return {
    ok: true,
    kind: 'audio',
    soundId: plan.sfxId,
    name: plan.name,
    startFrame: plan.startFrame,
    ripple,
  };
}

function commitMotionGraphicPlan(ctx: AgentContext, plan: OpResult, ripple: boolean): OpResult {
  const template = ctx.templates.find((item) => item.id === plan.templateId);
  if (!template) return { error: `template vanished: ${plan.templateId}` };
  ctx.commands.addMotionGraphic(template, {
    track: plan.track as string | undefined,
    startFrame: plan.startFrame as number | undefined,
    ripple,
  });
  return {
    ok: true,
    kind: 'motion-graphic',
    templateId: template.id,
    name: template.name,
    track: plan.track,
    ripple,
  };
}

function commitMediaPlan(ctx: AgentContext, plan: OpResult): OpResult {
  const asset = (ctx.getDoc().assets ?? []).find((item) => item.id === plan.assetId);
  if (!asset) return { error: `pool asset vanished: ${String(plan.assetId)}` };
  const placed = typeof plan.durationInFrames === 'number'
    ? { ...asset, durationInFrames: Number(plan.durationInFrames) }
    : asset;
  const itemId = ctx.commands.addMediaItem(placed, {
    track: plan.track as string,
    startFrame: plan.startFrame as number | undefined,
  });
  return {
    ok: true,
    kind: plan.kind,
    placed: {
      assetId: asset.id,
      itemId,
      name: asset.name,
      kind: asset.kind,
      track: plan.track,
      startFrame: plan.startFrame ?? 'appended',
      durationInFrames: placed.durationInFrames,
    },
  };
}

function commitTextPlan(ctx: AgentContext, plan: OpResult, ripple: boolean): OpResult {
  const itemId = ctx.commands.addTextClip({
    track: plan.track as string | undefined,
    startFrame: plan.startFrame as number | undefined,
    durationInFrames: plan.durationInFrames as number | undefined,
    ripple,
    name: plan.name as string | undefined,
    text: plan.text as string | undefined,
    fontSize: plan.fontSize as number | undefined,
    color: plan.color as string | undefined,
    fontWeight: plan.fontWeight as number | undefined,
    align: plan.align as 'left' | 'center' | 'right' | undefined,
  });
  return {
    ok: true,
    kind: 'text',
    placed: {
      itemId,
      name: plan.name ?? '文字',
      text: plan.text,
      track: plan.track,
      startFrame: plan.startFrame ?? 'appended',
      durationInFrames: plan.durationInFrames ?? 90,
      color: plan.color,
      fontSize: plan.fontSize,
    },
    ripple,
  };
}

function commitSolidPlan(ctx: AgentContext, plan: OpResult, ripple: boolean): OpResult {
  const itemId = ctx.commands.addSolidItem({
    track: plan.track as string | undefined,
    startFrame: plan.startFrame as number | undefined,
    durationInFrames: plan.durationInFrames as number | undefined,
    color: plan.color as string | undefined,
    name: plan.name as string | undefined,
    ripple,
  });
  return {
    ok: true,
    kind: 'solid',
    placed: {
      itemId,
      name: plan.name ?? '纯色',
      color: plan.color ?? '#1a1a1a',
      track: plan.track,
      startFrame: plan.startFrame ?? 'appended',
      durationInFrames: plan.durationInFrames ?? 150,
    },
    ripple,
  };
}
