import assert from 'node:assert/strict';
import { parseFirecrawlImages, parseFirecrawlVideos } from './stock.ts';

const images = parseFirecrawlImages([
  {
    title: 'Pixabay city',
    imageUrl: 'https://cdn.pixabay.com/photo/city_1280.jpg',
    imageWidth: 1280,
    imageHeight: 720,
    url: 'https://pixabay.com/photos/city-1/',
  },
  {
    title: 'Pexels portrait',
    imageUrl: 'https://images.pexels.com/photos/2/portrait.jpeg',
    imageWidth: 720,
    imageHeight: 1280,
    url: 'https://www.pexels.com/photo/portrait-2/',
  },
], 'landscape', 5);
assert.equal(images.length, 1);
assert.equal(images[0]?.platform, 'pixabay');
assert.equal(images[0]?.kind, 'image');

const videos = parseFirecrawlVideos(`
[Edit video](https://canva.com/?file-url=https%3A%2F%2Fcdn.pixabay.com%2Fvideo%2F2019%2F02%2F01%2F21116-315137080_large.mp4&external-id=1)
[duplicate](https://canva.com/?file-url=https%3A%2F%2Fcdn.pixabay.com%2Fvideo%2F2019%2F02%2F01%2F21116-315137080_large.mp4&external-id=1)
[second](https://canva.com/?file-url=https%3A%2F%2Fcdn.pixabay.com%2Fvideo%2F2020%2F01%2F01%2F99-100_large.mp4&external-id=2)
`, 2);
assert.equal(videos.length, 2);
assert.equal(videos[0]?.kind, 'video');
assert.equal(videos[0]?.previewUrl, 'https://cdn.pixabay.com/video/2019/02/01/21116-315137080_tiny.jpg');

console.log('stock Firecrawl fallback check passed');
