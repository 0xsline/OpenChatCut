import { Video as BrowserVideo, type VideoProps as BrowserVideoProps } from '@remotion/media';

export type RuntimeVideoProps = Pick<BrowserVideoProps, 'src' | 'trimBefore' | 'trimAfter' | 'playbackRate' | 'volume' | 'style' | 'muted'> & {
  browserRenderer: boolean;
};

export function RuntimeVideo({ browserRenderer, ...props }: RuntimeVideoProps) {
  // Use the same WebCodecs/Mediabunny path for server renders and browser
  // exports. OffthreadVideo can evict a frame while seeking high-resolution
  // uploads, which surfaces as "No frame found at position" even when the
  // source and timestamps are valid.
  const objectFit = props.style?.objectFit;
  const mediaObjectFit = objectFit === 'fill' || objectFit === 'contain' || objectFit === 'cover'
    || objectFit === 'none' || objectFit === 'scale-down' ? objectFit : undefined;
  const style = mediaObjectFit ? { ...props.style, objectFit: undefined } : props.style;
  return <BrowserVideo
    {...props}
    style={style}
    {...(mediaObjectFit ? { objectFit: mediaObjectFit } : {})}
    {...(browserRenderer ? {} : { headless: false })}
  />;
}
