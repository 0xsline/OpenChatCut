import assert from 'node:assert/strict';
import { Video as BrowserVideo } from '@remotion/media';
import { RuntimeVideo } from './RuntimeVideo';

const style = { width: '100%', height: '100%', objectFit: 'cover' as const };

const serverElement = RuntimeVideo({
  browserRenderer: false,
  src: '/media/uploads/high-resolution.mp4',
  style,
});
assert.equal(serverElement.type, BrowserVideo, 'server renders must use the media video implementation');
assert.equal(serverElement.props.headless, false, 'server renders must decode frames instead of returning headless null');
assert.equal(serverElement.props.objectFit, 'cover', 'CSS objectFit must map to the media prop');
assert.equal(serverElement.props.style.objectFit, undefined, 'objectFit must not remain as a CSS prop');

const browserElement = RuntimeVideo({
  browserRenderer: true,
  src: '/media/uploads/high-resolution.mp4',
  style,
});
assert.equal(browserElement.type, BrowserVideo, 'browser exports must use the media video implementation');
assert.equal(browserElement.props.headless, undefined, 'browser exports keep the preview default');
assert.equal(browserElement.props.objectFit, 'cover');

console.log('TimelineMediaLayer.verify: ok');
