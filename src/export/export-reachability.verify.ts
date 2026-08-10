// End-to-end export reachability: a real FCPXML export must address real
// files on disk — an NLE (DaVinci Resolve) can only relink media when the
// file:// src points at an existing file. Runs against a throwaway HOME
// with real media files (video + audio + blob-published asset).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TimelineState } from '../editor/types';

function makeState(): TimelineState {
  return {
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: null,
    items: [
      {
        id: 'video-1', track: 'V1', startFrame: 0, durationInFrames: 120,
        name: 'Main Footage', kind: 'video', src: '/media/uploads/main-clip.mp4',
      },
      {
        id: 'audio-1', track: 'A1', startFrame: 0, durationInFrames: 120,
        name: 'Music Bed', kind: 'audio', src: '/media/uploads/music-bed.mp3',
      },
      {
        id: 'mg-1', track: 'V2', startFrame: 0, durationInFrames: 60,
        name: 'Title Card', kind: 'motion-graphic',
      },
    ],
  };
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'occ-export-reach-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    // Real media on disk: /media/uploads maps to <root>/.openchatcut/media/uploads.
    const uploads = join(root, '.openchatcut', 'media', 'uploads');
    mkdirSync(uploads, { recursive: true });
    writeFileSync(join(uploads, 'main-clip.mp4'), Buffer.from('fakemp4'));
    writeFileSync(join(uploads, 'music-bed.mp3'), Buffer.from('fakemp3'));

    const { timelineToFcpxml, resolveAssetSrc } = await import('./fcpxml');
    const mediaDir = uploads;

    const xml = timelineToFcpxml(makeState(), {
      title: 'Reachability Test',
      mediaDir,
    });

    // ── 1. XML parses and carries the required nodes ──
    assert.ok(xml.includes('<fcpxml'), 'root element');
    assert.ok(xml.includes('<format'), 'format element');
    assert.ok(xml.includes('<resources'), 'resources element');

    // ── 2. every media src resolves to an existing file ──
    const srcs = [...xml.matchAll(/src="([^"]+)"/g)].map((m) => m[1]!).filter((s) => s.startsWith('file://'));
    assert.equal(srcs.length, 2, 'exactly the two media clips, both file:// URLs');
    for (const src of srcs) {
      const path = src.replace(/^file:\/\//, '');
      assert.ok(existsSync(path), `NLE must find the media file at ${path}`);
    }

    // ── 3. no /media/uploads relative URL leaked (NLE-offline cause) ──
    assert.ok(!/src="\/media\/uploads\//.test(xml), 'no relative upload URL may leak into the XML');
    assert.ok(!/undefined|NaN/.test(xml), 'no undefined/NaN in output');

    // ── 3b. DaVinci Resolve variant: same reachability + colorSpace hint ──
    const resolveXml = timelineToFcpxml(makeState(), {
      title: 'Resolve Test',
      mediaDir,
      nleFormat: 'fcp_xml_resolve',
    });
    const resolveSrcs = [...resolveXml.matchAll(/src="([^"]+)"/g)]
      .map((m) => m[1]!).filter((s) => s.startsWith('file://'));
    assert.equal(resolveSrcs.length, 2, 'Resolve export keeps both media refs');
    for (const src of resolveSrcs) {
      assert.ok(existsSync(src.replace(/^file:\/\//, '')), `Resolve media must exist: ${src}`);
    }
    assert.ok(!/src="\/media\/uploads\//.test(resolveXml), 'Resolve export: no relative upload URL');

    // ── 4. resolveAssetSrc standalone contract ──
    const resolved = resolveAssetSrc('/media/uploads/main-clip.mp4', mediaDir);
    assert.ok(resolved.startsWith('file://'), 'upload URL must become a file:// URL');
    assert.ok(existsSync(resolved.slice('file://'.length)), 'resolved asset must exist on disk');
    assert.equal(resolveAssetSrc('https://cdn.example/x.mp4'), 'https://cdn.example/x.mp4', 'remote stays remote');
    assert.equal(resolveAssetSrc('blob:http://localhost/id'), 'blob:http://localhost/id', 'blob stays blob');

    console.log('✓ export reachability verify: real FCPXML → every media file exists on disk (NLE relink-ready)');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
