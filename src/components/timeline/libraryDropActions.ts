// Library material drag and drop application (translated verbatim from Timeline.tsx): fx/lut/zoom/transition drop into clip,
// Sound/template falls to the track (the track of the right type is automatically selected). Reasons for rejection must be given (notice) - before
// Silently return false, the user only sees "No response after dragging".
import {
  CSS_TRANSITION_TYPES, TRANSITION_LABELS, defaultTrackId, timelineTrackIds, trackKind,
  type TimelineItem, type TimelineState, type TrackId, type TransitionType, type ZoomShape,
} from '../../editor/types';
import type { EditorCommands } from '../../editor/store';
import type { LibraryDragPayload } from '../../library/drag';
import { asPluginTpl, asPluginZoom } from '../../library/pluginResources';
import { isPluginAssetId } from '../../plugins/types';
import { customTransitionUniforms, getCustomTransition } from '../../gl/customTransitions';
import { ALL_FX, serializableDefsFor } from '../../gl/fx/effects';
import { TEMPLATES } from '../../editor/initial';
import { t } from '../../i18n/locale';
import { isolateVoiceOnSrc, isIsolateAudioFxId, strengthFromAudioFxId } from '../../audio/isolateVoice';
import { showAppToast } from '../../ui/appToast';

interface DropCtx {
  state: TimelineState;
  commands: EditorCommands;
  notice: (msg: string) => void;
}

export function applyLibraryToClip({ state, commands, notice }: DropCtx, payload: LibraryDragPayload, item: TimelineItem): boolean {
  const visual = item.kind !== 'audio';
  if (payload.kind === 'fx' || payload.kind === 'lut') {
    // GIF does not enter the GL pipeline (MediaFill/ClipFx only textures video/image), and it will not be rendered if accepted - honest rejection
    if (item.kind !== 'video' && item.kind !== 'image') {
      notice(t('{kind}Can only be used in videos / on the picture fragment (GIF/MG Not leaving GL special effects pipeline)', { kind: payload.kind === 'lut' ? 'LUT' : t('special effects') }));
      return false;
    }
    if (!(payload.id in ALL_FX)) return false;
    const prev = item.effects ?? [];
    const next = [
      ...prev.filter((e) => e.assetId !== payload.id),
      { id: `fx_${payload.id}`, assetId: payload.id, overrides: {} },
    ];
    commands.setItemEffects(item.id, next, serializableDefsFor(next));
    commands.selectItem(item.id);
    return true;
  }
  if (payload.kind === 'zoom') {
    if (!visual) { notice(t('Zoom can only be used on frame clips')); return false; }
    // Plug-in curve: envelope follows payload.data (used after shape verification)
    const pluginZoom = payload.data ? asPluginZoom(payload.data) : null;
    commands.setItemZoom(item.id, pluginZoom ?? { shape: payload.id as ZoomShape, magnification: 1.5, envelope: undefined, label: undefined });
    commands.selectItem(item.id);
    return true;
  }
  if (payload.kind === 'audio-fx') {
    if (item.kind !== 'video' && item.kind !== 'audio') {
      notice(t('Vocal isolation can only be used in videos / on audio clip'));
      return false;
    }
    if (!item.src?.startsWith('/media/uploads/')) {
      notice(t('Need to be uploaded to the media pool first (/media/uploads）'));
      return false;
    }
    if (!isIsolateAudioFxId(payload.id)) {
      notice(t('Unknown audio effects:{id}', { id: payload.id }));
      return false;
    }
    const strength = strengthFromAudioFxId(payload.id);
    commands.selectItem(item.id);
    // Async denoise — accept drop immediately; toast progress / result.
    showAppToast(t('Vocal isolation is being processed...'), { ms: 60_000 });
    void isolateVoiceOnSrc(item.src, strength, { force: true })
      .then((r) => {
        commands.setItemDenoise(item.id, r.path, r.strength);
        showAppToast(t('Vocal isolation applied'));
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : t('Vocal isolation failed');
        showAppToast(msg, { error: true });
        notice(msg);
      });
    return true;
  }
  if (payload.kind === 'transition') {
    // incoming = this clip;reducer requires adjacent clips in front of the same track - a priori and give reasons
    const prior = state.items.find((x) =>
      x.id !== item.id && x.track === item.track
      && Math.abs((x.startFrame + x.durationInFrames) - item.startFrame) <= 2);
    if (!prior) {
      notice(t('The transition hangs at the seam of two segments: please drag to the "next" clip, which must be preceded by an adjacent clip on the same track.'));
      return false;
    }
    // GLSL exclusive transitions only have full effect on video/picture pairs; DOM fragments (MG/text/GIF...) will degenerate into dissolves - apply as usual but click broken
    const glCapable = (k: TimelineItem['kind']) => k === 'video' || k === 'image';
    const isPlugin = isPluginAssetId(payload.id);
    const displayName = isPlugin ? payload.name : t(TRANSITION_LABELS[payload.id as TransitionType] ?? payload.id);
    if (!CSS_TRANSITION_TYPES.has(payload.id) && !(glCapable(prior.kind) && glCapable(item.kind))) {
      notice(t('「{name}"Only in video/There are complete effects between picture fragments,MG/Fragments such as text will appear as a dissolve', { name: displayName }));
    }
    if (isPlugin) {
      // Plug-in transition: the registry takes a frag snapshot into TransitionItem (same mechanism as submit_shader)
      const def = getCustomTransition(payload.id);
      if (!def) { notice(t('Plug-in transition "{name}》Not installed or uninstalled', { name: payload.name })); return false; }
      commands.addTransition(item.id, 'custom-shader', undefined, { frag: def.frag, uniforms: customTransitionUniforms(def), label: def.label });
    } else {
      commands.addTransition(item.id, payload.id as TransitionType);
    }
    commands.selectItem(item.id);
    return true;
  }
  return false;
}

export function applyLibraryToTrack(
  { state, commands }: DropCtx,
  payload: LibraryDragPayload,
  trackId: TrackId,
  startFrame: number,
  ripple: boolean,
): boolean {
  const trackIds = timelineTrackIds(state);
  if (payload.kind === 'sound') {
    if (trackKind(state, trackId) !== 'audio') {
      // auto-pick an audio track
      const audioTrack = trackIds.find((t) => trackKind(state, t) === 'audio') ?? defaultTrackId(state, 'audio');
      if (!audioTrack) return false;
      trackId = audioTrack;
    }
    const dur = Math.max(1, Math.round((payload.seconds ?? 1) * state.fps));
    commands.addAudio(
      {
        id: `sfx_${payload.id}`,
        name: payload.name,
        category: 'sfx',
        src: payload.src ?? `/sound-effects/${payload.id}.mp3`,
        durationInFrames: dur,
      },
      { track: trackId, startFrame, ripple },
    );
    return true;
  }
  if (payload.kind === 'template') {
    // The plug-in template is not in TEMPLATES: Tpl goes with payload.data (the sandbox keeps the secret as usual)
    const tpl = TEMPLATES.find((t) => t.id === payload.id) ?? (payload.data ? asPluginTpl(payload.data) : null);
    if (!tpl) return false;
    // prefer video track under cursor
    let t = trackId;
    if (trackKind(state, t) !== 'video') {
      t = trackIds.find((id) => trackKind(state, id) === 'video') ?? defaultTrackId(state, 'video') ?? trackId;
    }
    commands.addMotionGraphic(tpl, { track: t, startFrame, ripple });
    return true;
  }
  return false;
}
