# Design QA — source editor parity

## Visual truth

- Assets panel: `/Users/qinpx/Desktop/Snapzy/Snapzy_2026-07-14_12-18-19_964.png`
- Timeline: `/Users/qinpx/Desktop/Snapzy/Snapzy_2026-07-14_12-18-27_744.png`
- Source implementation evidence: `/Users/qinpx/Desktop/project/chatcut-reverse/resources/bundles/decompiled/editor/entry.js`

## Implementation evidence

- Full editor: `/Users/qinpx/Desktop/project/chatcut-clone-gpt/design-qa-implementation-full.png`
- Corrected dock ratio: `/Users/qinpx/Desktop/project/chatcut-clone-gpt/design-qa-layout-ratio.png`
- Full-layout comparison: `/Users/qinpx/Desktop/project/chatcut-clone-gpt/design-qa-layout-comparison.png`
- Assets crop: `/Users/qinpx/Desktop/project/chatcut-clone-gpt/design-qa-implementation-assets.png`
- Timeline crop: `/Users/qinpx/Desktop/project/chatcut-clone-gpt/design-qa-implementation-timeline.png`
- Assets comparison: `/Users/qinpx/Desktop/project/chatcut-clone-gpt/design-qa-assets-comparison.png`
- Timeline comparison: `/Users/qinpx/Desktop/project/chatcut-clone-gpt/design-qa-timeline-comparison.png`

## Viewport and state

- Browser viewport: `1353 × 872`.
- Assets comparison normalizes the `405 × 519` implementation crop to the `803 × 1000` Retina reference.
- Timeline comparison normalizes the `1353 × 300` implementation crop to the `2048 × 581` Retina reference.
- Dark mode, `我的素材` selected, grid view, 10 QA assets, one active timeline, playhead at zero, captions enabled.
- Asset names, thumbnails, durations and timeline duration intentionally reflect the local QA project rather than copying the source project's user data.

## Required fidelity surfaces

- Typography: system sans stack, selected/unselected tab hierarchy, compact metadata and tabular timecodes.
- Layout: AI column spans the full editor below the header; Timeline spans only Assets + Viewer; screenshot-derived 22.47% / 27.72% / 49.81% columns and 38.18% lower-right timeline split; 3-column assets grid and grouped toolbar controls.
- Colors: source dark chrome, blue/green track badges, green audio/video clips, purple Motion Graphic clips and orange active-tool accent.
- Image quality: native media thumbnails with `cover`; audio cards use the source-style line icon; evidence uses lossless PNG.
- Copy/content: source control order and labels are preserved; local project media copy remains real project data.

## Comparison history

1. Pass 1: timeline was confined to the preview column; asset management controls were exposed; track headers were narrow; toolbar had clone-only actions.
2. Fix 1: rebuilt assets toolbar/cards, created source-size track headers, regrouped timeline controls, and preserved existing interactions behind the source chrome.
3. Pass 2: asset rows were too dense and the audio glyph was oversized; audio clips lacked the source waveform band; the source feedback affordance was missing.
4. Fix 2: matched source row rhythm, reduced the audio glyph, added waveform treatment and the functional feedback popover, then repeated browser interaction and console regression.
5. Dock correction: full source screenshot and decompiled Dockview tree proved that Timeline belongs below Assets + Viewer, while AI spans the whole lower height. The implementation was corrected and recaptured in `design-qa-layout-ratio.png`.
6. Final evidence: comparison PNGs and corrected dock screenshot above. Remaining visual differences are content-state differences (media, clip arrangement and duration), not component-structure differences.

## Browser verification

- Asset search, type filter, sort, grid/list switch, folder create/delete and card management passed.
- Timeline selection/trim switching, captions toggle and feedback popover passed.
- Dynamic-track regression used the self-created project `/editor/37f7bee9-0516-459c-8a13-9ea364c14843`: create/delete/reorder/rename, lock enforcement, collapse, anchor/follower role, stable-id alias renumbering and non-empty delete guard passed.
- Dynamic-track model evidence: `track-tools.check.ts` passed.
- Source correction: the chevron beside CC is the caption-style/translation menu, not track management. The invented menu was removed; all 21 source presets and the 8-language submenu are now wired. Evidence: `/Users/qinpx/Desktop/project/chatcut-clone-gpt/qa-caption-style-menu.png`; `styles.check.ts` passed.
- Caption menu closes on outside pointer interaction; live `/llm/v1/messages` translation produced `源样式测试` from `SOURCE STYLE TEST` and rendered it as the bilingual second line.
- Playback regression on the self-created 3-second Bar Chart project passed: isolating the Remotion Player and 211-card template gallery from root playhead renders reduced the 6-second foreground run from `p95 116.6ms / 3971ms long tasks / 63 distinct frames` to `p95 33.4ms / 530ms long tasks / 86 distinct frames`.
- Page console errors: none.

final result: passed
