import { createContext, useContext } from 'react';
import { useRemotionEnvironment } from 'remotion';

/**
 * Decoder behind a video layer. 'webcodecs' is @remotion/media's <Video>
 * (Mediabunny + the browser's WebCodecs decoder); 'offthread' is Remotion's
 * <OffthreadVideo> (the FFmpeg compositor, outside the browser).
 * remotion/video-decoder.mjs picks the server render's value per platform.
 */
export type ServerVideoDecoder = 'webcodecs' | 'offthread';

export function isServerVideoDecoder(value: unknown): value is ServerVideoDecoder {
  return value === 'webcodecs' || value === 'offthread';
}

/** Provided by TimelineComposition from its `serverVideoDecoder` input prop. */
export const ServerVideoDecoderContext = createContext<ServerVideoDecoder>('webcodecs');

export interface VideoDecodeEnvironment {
  isRendering: boolean;
  isClientSideRendering: boolean;
  isPlayer: boolean;
}

/**
 * Only the headless server render honours the server's choice. The Player and
 * the in-browser export (@remotion/web-renderer, which cannot run
 * <OffthreadVideo> at all) always decode with @remotion/media.
 */
export function runtimeVideoDecoder(
  requested: ServerVideoDecoder,
  environment: VideoDecodeEnvironment,
  browserRenderer = false,
): ServerVideoDecoder {
  if (browserRenderer || environment.isClientSideRendering || environment.isPlayer
    || !environment.isRendering) return 'webcodecs';
  return requested;
}

/**
 * Every decoded video layer of one composition — plain clips, background
 * fills, shared runs and GL effect inputs — asks here, so a render never mixes
 * decoders between an effect clip and its non-effect neighbours.
 */
export function useRuntimeVideoDecoder(browserRenderer = false): ServerVideoDecoder {
  const requested = useContext(ServerVideoDecoderContext);
  const environment = useRemotionEnvironment();
  return runtimeVideoDecoder(requested, environment, browserRenderer);
}

/**
 * @remotion/media shows the last frame whose timestamp is at most 1 ms after
 * the requested time (the tolerance in its getFrameFromTimestamp); the FFmpeg
 * compositor takes the last frame at or before it. For fractional-rate footage
 * (29.97 fps in a 30 fps timeline) the two therefore disagree by one source
 * frame whenever a frame lands inside that millisecond — so the compositor is
 * asked 1 ms later, and a Windows export shows the frames the Player shows.
 */
export const WEBCODECS_FRAME_TOLERANCE_SECONDS = 0.001;

/** trimBefore (timeline frames) for <OffthreadVideo> that selects the same source frames as @remotion/media. */
export function offthreadTrimBefore(trimBefore: number | undefined, fps: number): number {
  return (trimBefore ?? 0) + WEBCODECS_FRAME_TOLERANCE_SECONDS * fps;
}

/**
 * <OffthreadVideo> extracts BMP frames unless `transparent` asks for (slower)
 * PNG. Alpha video reaches this app's timelines as WebM — VP9-alpha MG bakes
 * and the desktop importers' transparent-MOV proxies — so WebM keeps its alpha
 * and ordinary camera/phone footage keeps the fast opaque extraction.
 */
export function offthreadVideoTransparent(src: string): boolean {
  const path = src.split(/[?#]/, 1)[0] ?? '';
  return /\.webm$/i.test(path);
}
