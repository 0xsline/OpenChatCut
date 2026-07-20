// Built-in design-style presets (all 24, with ids/names/colors/fonts/styleGuide).
// Roles are free-form.
import type { DesignStyle } from './types';

export interface DesignPreset {
  id: string;
  name: string;
  style: DesignStyle;
}

export const DESIGN_STYLE_PRESETS: DesignPreset[] = [
  {
    id: '53417178-6788-5241-b0d6-8925371029e0',
    name: 'Terracotta Editorial',
    style: {
      colors: [
        { role: 'background', value: '#A03B15' },
        { role: 'accent copper', value: '#D4763A' },
        { role: 'accent amber', value: '#E8A54B' },
        { role: 'accent tan', value: '#C9956B' },
        { role: 'text', value: '#FFFFFF' },
        { role: 'text secondary', value: 'rgba(255,255,255,0.7)' },
      ],
      fonts: [
        { role: 'heading', family: 'Montserrat' },
        { role: 'accent', family: 'Playfair Display' },
        { role: 'Chinese', family: 'HarmonyOS Sans' },
      ],
      styleGuide: 'MOTION Entry: spring(damping:28, stiffness:60, mass:1.4) — heavy deliberate settle. Bars: spring(damping:30, stiffness:50, mass:1.6), stagger +12f per bar. Small elements: spring(damping:18, stiffness:140, mass:0.7). Stagger rhythm: major groups 24f apart, items within group 8-12f apart. Title drifts down 40px. Name slides left 36px. Bullets slide left 20px. Quote drifts up 24px. Timeline nodes rise 12px. Exit (last 22f): opacity 1→0, blur 0→12px, translateY 0→20px. …',
    },
  },
  {
    id: '1be3c6ae-bf35-58a4-b8d3-9d50d6dd49ac',
    name: 'Retro Duotone Print',
    style: {
      colors: [
        { role: 'background', value: '#F2EDE4' },
        { role: 'primary', value: '#1E3A6E' },
        { role: 'accent', value: '#E05030' },
      ],
      fonts: [
        { role: 'heading', family: 'Anton' },
        { role: 'body', family: 'Inter' },
        { role: 'quote', family: 'Dancing Script' },
        { role: 'Chinese heading', family: 'Pangmen Zhengdao Biaoti Ti' },
        { role: 'Chinese body', family: 'Noto Sans SC' },
        { role: 'Chinese quote', family: 'Huxiaobo Nanshen Ti' },
      ],
      styleGuide: 'MOTION Typewriter entrance — all text character-by-character at 0.4-0.6 chars/frame. No opacity, no scale, no translate. Bar fills linearly 20f. Timeline line draws left-to-right linearly. SVG halftone dot overlay uses fillOpacity (not CSS opacity). Decorative star static. No CSS opacity anywhere. COLOR Warm cream #F2EDE4. Strict duotone: deep navy #1E3A6E + red-orange #E05030. Title \'RETRO\' red outline (WebkitTextStroke), \'DECODE\' solid navy. Bars alternate. …',
    },
  },
  {
    id: '270e88b2-7952-5755-bcb4-f13d29edfe8d',
    name: 'Highlighter Notebook',
    style: {
      colors: [
        { role: 'background', value: '#B8D8D0' },
        { role: 'paper', value: '#FFFFFF' },
        { role: 'accent', value: '#FFD700' },
        { role: 'text', value: '#2A2A2A' },
        { role: 'grid', value: '#E5E7EB' },
        { role: 'sticky', value: '#FEF08A' },
      ],
      fonts: [
        { role: 'heading', family: 'Caveat' },
        { role: 'body', family: 'Inter' },
        { role: 'Chinese heading', family: 'Douyin Meihao Ti' },
        { role: 'Chinese body', family: 'Noto Sans SC' },
      ],
      styleGuide: 'MOTION Notebook reveal — highlighter strokes sweep behind text (width left→right). Checkmarks draw via strokeDasharray. Paper clip slides from top. Spring(damping:15) for decorative pops. Stagger 15f between groups. Timeline nodes appear along dashed line sequentially. COLOR Soft teal-green #B8D8D0 background. White paper panel #FFFFFF. Yellow highlighter #FFD700 behind key words. Text dark charcoal #2A2A2A. Grid lines #E5E7EB. Sticky note #FEF08A. …',
    },
  },
  {
    id: '15480d1f-0910-592a-a45a-3b4f4467d09f',
    name: 'Soft Organic Gradient',
    style: {
      colors: [
        { role: 'background', value: '#FFFDF7' },
        { role: 'text', value: '#1A1A1A' },
        { role: 'blob warm', value: '#FFB885' },
        { role: 'blob green', value: '#C8D5B9' },
        { role: 'chart accent 1', value: '#ffbca6' },
        { role: 'chart accent 2', value: '#c2d5c4' },
        { role: 'chart accent 3', value: '#f7e2a9' },
      ],
      fonts: [
        { role: 'heading', family: 'Playfair Display' },
        { role: 'body', family: 'Inter' },
        { role: 'Chinese heading', family: 'LXGW WenKai' },
        { role: 'Chinese body', family: 'Noto Sans SC' },
      ],
      styleGuide: 'Warm, refined, organic. Cream/off-white canvas with soft pastel gradient blobs (peach + sage). Serif italic chapter numbers, uppercase serif titles, Inter body text.Motion language: - Easing: smoothSettle (1 - pow(1-t, 3.5)) for all entrances. No spring, no bounce, no overshoot. - Data animation: bellCurveLate (slow start 40% → accelerate → settle) for charts/rings/bars. - Line drawing: lineDraw (1 - pow(1-t, 2.8)) for strokes and timeline paths. …',
    },
  },
  {
    id: '6d03e24c-da30-5289-a198-81fabab76656',
    name: 'Doodle Explainer',
    style: {
      colors: [
        { role: 'background', value: '#F8F4EE' },
        { role: 'primary', value: '#1B4A7A' },
        { role: 'accent', value: '#D44830' },
      ],
      fonts: [
        { role: 'heading', family: 'Fredoka' },
        { role: 'body', family: 'Montserrat' },
        { role: 'Chinese heading', family: 'Huxiaobo Nanshen Ti' },
        { role: 'Chinese body', family: 'Noto Sans SC' },
      ],
      styleGuide: 'MOTION Spring(damping:14, stiffness:150, mass:0.7) bouncy pop-in. Elements scale 0→1 with overshoot. Stagger 8f between items. Decorative stars/crosses rotate in. Name tag border draws via strokeDasharray. Timeline nodes scale with spring, stagger 15f. Exit: shrink + fade last 18f. COLOR Warm off-white #F8F4EE. Primary deep blue #1B4A7A. Accent red #D44830 for dots, decorations. Bar fills warm gold/tan. Hand-drawn borders. TYPE Fredoka (rounded friendly, 600-700) headings. …',
    },
  },
  {
    id: 'b1dafe2b-3914-5a83-b1e5-a33ea013d104',
    name: 'Emerald Deco',
    style: {
      colors: [
        { role: 'background', value: '#1B4D4D' },
        { role: 'accent', value: '#D4AF72' },
        { role: 'text', value: '#F5E6C8' },
      ],
      fonts: [
        { role: 'heading', family: 'Playfair Display' },
        { role: 'body', family: 'Playfair Display' },
        { role: 'Chinese', family: 'Noto Serif SC' },
      ],
      styleGuide: 'MOTION Spring(damping:15) for all entrances. Title translateY + opacity. Chart bars scaleX from left. Name tag scale 0.9→1 + opacity. Bullets translateX(-50→0) + opacity. Quote scale 0.95→1. Timeline line scaleX from center, diamond nodes appear when line reaches position (scale 0→1 over 8% progress). Line draws with ease-in-out cubic over 60f. COLOR Background deep teal #1B4D4D. Text cream #F5E6C8 and gold #D4AF72. Decorative elements muted gold. Bar fills gold. …',
    },
  },
  {
    id: 'b92da493-689c-5c29-a83f-c9d3b8e28c5e',
    name: 'Black Yellow Type',
    style: {
      colors: [
        { role: 'background', value: '#000000' },
        { role: 'accent', value: '#FFE500' },
        { role: 'text', value: '#FFE500' },
      ],
      fonts: [
        { role: 'heading', family: 'Oswald' },
        { role: 'body', family: 'Oswald' },
        { role: 'Chinese', family: 'HarmonyOS Sans' },
      ],
      styleGuide: 'MOTION Title slide-up with overflow:hidden mask — spring(damping:28, stiffness:60), conditional render at delay frame to prevent flash. Bars fill linearly. Bullets translateX(-30→0) spring(damping:15). Brand mark 3 yellow lines width grows. Timeline line scaleX left→right, circle nodes on line. No exit — hard cut. COLOR Pure black #000000. Bright yellow #FFE500 ONLY accent — all text, bars, dots, timeline. Two-color system only. No grey, no gradients. …',
    },
  },
  {
    id: '406e5dba-1903-5b22-8805-c6dd56170f65',
    name: 'Electric Impact Type',
    style: {
      colors: [
        { role: 'background', value: '#0A1A5C' },
        { role: 'accent', value: '#E8222C' },
        { role: 'text', value: '#FFFFFF' },
      ],
      fonts: [
        { role: 'heading', family: 'Anton' },
        { role: 'body', family: 'Anton' },
        { role: 'Chinese', family: 'Pangmen Zhengdao Biaoti Ti' },
      ],
      styleGuide: 'MOTION Word-by-word reveal — all text appears one word at a time, every 4 frames. No easing, no translate, no opacity on text — pure conditional render via string slicing. Bar fills static (appear at full width). Timeline nodes appear sequentially. Name/role appear as full blocks. Hard cut aesthetic. COLOR Deep electric blue #0A1A5C. Bright pure red #E8222C for title, bar fills, accent squares, role. White #FFFFFF for body, name, quotes, labels. Three-color system. …',
    },
  },
  {
    id: '1a08a7ea-e138-5ee0-922f-8a92219211d6',
    name: 'Acid Script Poster',
    style: {
      colors: [
        { role: 'background', value: '#D4F700' },
        { role: 'text', value: '#000000' },
        { role: 'badge', value: '#FFFFFF' },
      ],
      fonts: [
        { role: 'heading', family: 'Anton' },
        { role: 'script', family: 'Pinyon Script' },
        { role: 'Chinese', family: 'Douyin Meihao Ti' },
      ],
      styleGuide: 'MOTION Calligraphic reveal — title letters appear one by one, alternating condensed sans + ornate script within same word. Flourish SVG lines draw via strokeDasharray (40-60f). Spring(damping:15) for badge pop-in. Bars fill linearly. Decorative asterisk rotates slowly. COLOR Bright chartreuse #D4F700 background. All text/decoration pure black #000000. White #FFFFFF pill badge. No other colors. Black curling decorative flourish lines. …',
    },
  },
  {
    id: '45b2c117-1239-509b-8273-ea9418947646',
    name: 'Neon Grid Commerce',
    style: {
      colors: [
        { role: 'background', value: '#000000' },
        { role: 'accent', value: '#CCFF00' },
        { role: 'text', value: '#FFFFFF' },
      ],
      fonts: [
        { role: 'heading', family: 'Anton' },
        { role: 'mono', family: 'Space Mono' },
        { role: 'Chinese heading', family: 'Smiley Sans' },
        { role: 'Chinese body', family: 'Noto Sans SC' },
      ],
      styleGuide: 'MOTION Neon grid snap — elements appear in card-like grid cells with neon borders. Spring(damping:15) card pop-in. Bars fill linearly with neon color. Monospace text character-by-character for annotations. Hard rectangular shapes. Stagger 10f between cells. No exit — hard cut. COLOR Pure black #000000. Electric neon yellow-green #CCFF00 ONLY accent — title highlight, bars, borders, badges, timeline. Body white #FFFFFF. Two-accent: neon for emphasis, white for body. …',
    },
  },
  {
    id: '8fb8c58b-3568-5afd-bc66-91f6aaacd182',
    name: 'Pale Tech Dashboard',
    style: {
      colors: [
        { role: 'background', value: '#f5f5f7' },
        { role: 'text', value: '#222222' },
        { role: 'blob purple', value: '#b4a0ff' },
        { role: 'blob blue', value: '#80c0ff' },
        { role: 'accent gradient start', value: '#7BA5FF' },
        { role: 'accent gradient end', value: '#B588FF' },
      ],
      fonts: [
        { role: 'heading', family: 'Space Mono' },
        { role: 'display number', family: 'VT323' },
        { role: 'body', family: 'Inter' },
        { role: 'Chinese heading', family: 'ZCOOL QingKe HuangYou' },
        { role: 'Chinese body', family: 'Noto Sans SC' },
      ],
      styleGuide: 'Clean, technical, forward-looking. Near-white background with soft purple/blue gradient blobs. Space Mono monospace for titles (technical identity), VT323 for large display numbers, Inter for body/labels.Motion language: - Easing: smoothSettle for entrances. Large numbers use scale animation (0.9→1.0) for impact. - Data animation: bellCurveLate for horizontal bar charts. Bars use linear-gradient fills (purple→blue). …',
    },
  },
  {
    id: '3dc17649-3a10-5abb-9d11-dac31e22c839',
    name: 'Liquid Aura',
    style: {
      colors: [
        { role: 'background', value: '#0C0626' },
        { role: 'text', value: '#FFFFFF' },
        { role: 'accent', value: '#FFFFFF' },
        { role: 'blob deep purple', value: '#2a08d4' },
        { role: 'blob magenta', value: '#9111c9' },
        { role: 'blob blue', value: '#136df5' },
      ],
      fonts: [
        { role: 'heading', family: 'Montserrat' },
        { role: 'body', family: 'Inter' },
        { role: 'Chinese heading', family: 'ZCOOL QingKe HuangYou' },
        { role: 'Chinese body', family: 'Noto Sans SC' },
      ],
      styleGuide: 'Dark, immersive, liquid. Deep purple/navy background with continuously moving liquid blobs (purple, magenta, blue). Bold italic Montserrat headings, Inter body. White text throughout.Motion language: - Easing: smoothSettle for text entrances. Liquid blobs use continuous sin/cos motion (slow, frame*0.012 speed). - Data animation: bellCurveLate for progress rings and metrics. strokeDasharray animation on SVG circles. …',
    },
  },
  {
    id: '95d9f34a-8602-5250-ad9f-5f754cc5efbf',
    name: 'Grainy Heatwave',
    style: {
      colors: [
        { role: 'background gradient start', value: '#FF6B00' },
        { role: 'background gradient end', value: '#7B2FBE' },
        { role: 'text', value: '#FFFFFF' },
      ],
      fonts: [
        { role: 'heading serif', family: 'Playfair Display' },
        { role: 'body', family: 'Inter' },
        { role: 'Chinese', family: 'Noto Sans SC' },
      ],
      styleGuide: 'MOTION Psychedelic fade-in — elements emerge from noise texture gradually. Spring(damping:20, stiffness:80) for smooth settle. Text opacity over 15f. Bars fill with hot orange/magenta. Timeline numbers appear sequentially. No exit. Pace: slow, dreamy, art-gallery. COLOR Full-frame orange #FF6B00 to purple #7B2FBE gradient with heavy noise/grain texture (distressed). All text pure white #FFFFFF. Bar fills hot orange/magenta. Background IS the visual. …',
    },
  },
  {
    id: 'f7027c39-106f-58d9-9e10-a01c94fbddb5',
    name: 'Blush Watercolor',
    style: {
      colors: [
        { role: 'background', value: '#F6EBEA' },
        { role: 'text', value: '#332211' },
        { role: 'wash pink', value: '#F28C8C' },
        { role: 'wash blue', value: '#8EC5DF' },
        { role: 'wash peach', value: '#F5C7A9' },
        { role: 'wash flower', value: '#ffe6e1' },
      ],
      fonts: [
        { role: 'heading', family: 'Playfair Display' },
        { role: 'body', family: 'Inter' },
        { role: 'Chinese heading', family: 'LXGW WenKai' },
        { role: 'Chinese body', family: 'Noto Sans SC' },
      ],
      styleGuide: 'Soft, organic, hand-painted feel. Warm blush/rose background with watercolor wash gradients (pink, blue, peach). Serif display titles (light weight, wide tracking), Inter for labels and body.Motion language: - Easing: smoothSettle for text and elements. Washes use slower fade (50 frames) to mimic paint spreading. - Data animation: bellCurveLate for pie/donut arcs. Arc strokeLinecap round for painted feel. - Line drawing: lineDraw for separator lines and timeline stems. …',
    },
  },
  {
    id: '035ef37f-5da9-5607-9f3c-bc7c062ae7a9',
    name: 'Archive Typewriter',
    style: {
      colors: [
        { role: 'background', value: '#EDE5D4' },
        { role: 'text', value: '#1A1A1A' },
        { role: 'accent', value: '#B89A5C' },
      ],
      fonts: [
        { role: 'heading', family: 'Special Elite' },
        { role: 'body', family: 'Special Elite' },
        { role: 'Chinese', family: 'LXGW WenKai TC' },
      ],
      styleGuide: 'MOTION Typewriter reveal — all text appears character-by-character at 0.5 chars/frame. No easing, no interpolation on text entrance. Bars fill linearly over 20f. Timeline line draws linearly left-to-right. Elements appear in sequence with ~20f gaps. No opacity, no scale, no translate. Pure conditional render + character slicing. COLOR Warm parchment #EDE5D4. Text pure black #1A1A1A. Accent warm gold #B89A5C for bar fills, timeline dots, role text. Bar track rgba(0,0,0,0.05). …',
    },
  },
  {
    id: '34abad33-4214-58ce-b10e-5ed301bbb8d5',
    name: 'Cubist Collage',
    style: {
      colors: [
        { role: 'background', value: '#FAFAF5' },
        { role: 'cobalt', value: '#1B4F8A' },
        { role: 'yellow', value: '#E8B930' },
        { role: 'red', value: '#C44532' },
        { role: 'teal', value: '#2A8B7A' },
        { role: 'orange', value: '#E87830' },
        { role: 'text', value: '#1A1A1A' },
      ],
      fonts: [
        { role: 'heading', family: 'Libre Baskerville' },
        { role: 'accent', family: 'Caveat' },
        { role: 'Chinese heading', family: 'Smiley Sans' },
        { role: 'Chinese accent', family: 'Douyin Meihao Ti' },
      ],
      styleGuide: 'MOTION Spring(damping:16, stiffness:130, mass:0.8) for bouncy energy. Color blocks scale in from center with overshoot. Text slides in from various directions. Stagger 6-8f. Bullet colored shapes (triangle/diamond/circle) rotate in. Timeline dots pop with scale bounce. Exit: scatter outward + fade 18f. COLOR White/cream #FAFAF5. Bold flat saturated: cobalt #1B4F8A, yellow #E8B930, red #C44532, teal #2A8B7A, orange #E87830. Text dark #1A1A1A. Each bar a different color. …',
    },
  },
  {
    id: '01c302d0-3b90-51e3-ae43-4a8a9ce947b5',
    name: 'Redline Tech',
    style: {
      colors: [
        { role: 'background', value: '#1a1a1a' },
        { role: 'accent-red-vivid', value: '#ff3742' },
        { role: 'accent-red', value: '#CC2222' },
        { role: 'accent-red-dark', value: '#aa1119' },
        { role: 'accent-red-panel', value: '#B71C1C' },
        { role: 'neon', value: '#ff5d5d' },
        { role: 'price-card', value: '#F26B6B' },
        { role: 'inner-glow', value: '#ffb1a8' },
        { role: 'divider', value: '#888888' },
        { role: 'meta-text', value: '#a0a0a0' },
      ],
      fonts: [
        { role: 'heading', family: 'Barlow Condensed' },
        { role: 'body', family: 'Inter' },
        { role: 'callout', family: 'Oswald' },
      ],
      styleGuide: 'Redline Tech is a dark industrial tech-review language: charcoal black surfaces, animated dot-grid texture, sharp red accent panels, diagonal wipes, masked reveals, skewed parallelogram callouts, and large condensed typography. Use Barlow Condensed / Oswald for impact labels and Inter for supporting text. Red carries the focal action; white carries core readable content; gray is only for secondary metadata or dividers. …',
    },
  },
  {
    id: '903852ac-5c36-508a-834f-02e9830cd2af',
    name: 'Black & White Neon',
    style: {
      colors: [
        { role: 'accent', value: '#ffffff' },
        { role: 'background', value: '#0a0a0e' },
        { role: 'text', value: '#ffffff' },
        { role: 'text-secondary', value: 'rgba(226,218,245,0.75)' },
        { role: 'glow-main', value: 'rgba(255,255,255,0.45)' },
        { role: 'glow-soft', value: 'rgba(255,255,255,0.20)' },
      ],
      fonts: [
        { role: 'heading', family: 'Inter' },
        { role: 'display', family: 'Montserrat' },
        { role: 'impact', family: 'Anton' },
      ],
      styleGuide: 'Black & White Neon is a restrained black-box studio language: near-black backgrounds, luminous white typography, white rings, line graphs, glowing strokes, and minimal card surfaces. The actual templates use mostly monochrome with occasional cool violet/lavender glow; keep that accent rare and secondary. One focal element should dominate each scene, with surrounding space left intentionally quiet. …',
    },
  },
  {
    id: 'fc851c93-fd07-546e-afb4-d2a186196ada',
    name: 'Violet Aura',
    style: {
      colors: [
        { role: 'primary', value: '#6c2cff' },
        { role: 'accent', value: '#f044ff' },
        { role: 'secondary', value: '#8d38ff' },
        { role: 'background', value: '#110620' },
        { role: 'text', value: '#ffffff' },
      ],
      fonts: [
        { role: 'heading', family: 'DM Sans' },
        { role: 'body', family: 'DM Sans' },
      ],
      styleGuide: 'Violet Aura is a dreamlike reflective explainer language: deep purple-black backgrounds, violet-to-pink gradient blooms, soft radial glow, oversized translucent numbers, rounded cards, and high-contrast white type. DM Sans with heavy weights creates the main structure; gradients and glow create atmosphere, not clutter. Each MG should be built around one dominant visual idea: a question list, a counter, a glowing chart, a chapter statement, or a quote card. …',
    },
  },
  {
    id: '972c825a-5e8d-5992-9379-a8d6b1a1ab68',
    name: 'Warm Paper',
    style: {
      colors: [
        { role: 'background', value: '#f8f5ee' },
        { role: 'texture', value: '#eee9de' },
        { role: 'accent', value: '#f5965f' },
        { role: 'text', value: '#1a1a1a' },
        { role: 'text-on-dark', value: '#ffffff' },
        { role: 'secondary', value: '#4A4A4A' },
      ],
      fonts: [
        { role: 'heading', family: 'Playfair Display' },
        { role: 'body', family: 'Playfair Display' },
      ],
      styleGuide: 'Warm Paper is a soft printed-editorial language: cream paper backgrounds, subtle texture, coral-orange accents, organic wave shapes, pebble badges, and elegant serif typography. Playfair Display carries the voice: reflective, literary, warm, and edited. Each scene should have one clear focal element; coral accents should mark that focal point rather than decorate everything. …',
    },
  },
  {
    id: '5f0d36ec-2d10-59aa-a965-6c5ef6174432',
    name: 'Modern Editorial',
    style: {
      colors: [
        { role: 'background', value: '#f5f0e8' },
        { role: 'background-chart', value: '#e8e4de' },
        { role: 'accent', value: '#FF6B35' },
        { role: 'highlight', value: '#FFEA00' },
        { role: 'chart-warm-light', value: '#f5d4b8' },
        { role: 'chart-warm-mid', value: '#f0b896' },
        { role: 'chart-warm-dark', value: '#e8945a' },
        { role: 'chart-warm-deep', value: '#c8622a' },
        { role: 'text', value: '#1a1a1a' },
        { role: 'text-secondary', value: '#444444' },
        { role: 'axis', value: '#cccccc' },
      ],
      fonts: [
        { role: 'heading', family: 'Roboto' },
        { role: 'body', family: 'Roboto' },
      ],
      styleGuide: 'Modern Editorial is a light analytical explainer language: warm gray paper surfaces, notebook/newsprint grids, serif editorial titles, Roboto utility text, math or data-mark watermarks, poll cards, charts, and restrained highlight marks. It should feel like a data journalist\'s annotated notebook, not a decorative scrapbook. Use black and gray as the main language; use orange or yellow highlight only when a specific value or phrase needs emphasis. …',
    },
  },
  {
    id: '62cf874c-cd8e-5c82-9073-5763e9c79fbb',
    name: 'Orange Minimal',
    style: {
      colors: [
        { role: 'accent', value: '#FF9500' },
        { role: 'background', value: '#F0EFED' },
        { role: 'background-warm', value: '#FFD580' },
        { role: 'background-neutral', value: '#EBEBEB' },
        { role: 'text', value: '#1A1A1A' },
        { role: 'text-on-dark', value: '#FFFFFF' },
        { role: 'secondary', value: '#4A4A4A' },
      ],
      fonts: [
        { role: 'heading', family: 'Inter' },
        { role: 'body', family: 'Inter' },
      ],
      styleGuide: 'Orange Minimal is a warm business / creator explainer language: paper-like neutral backgrounds, flat geometric blocks, a single saturated orange focal accent, bold Inter typography, numbered badges, simple timelines, and clean charts. The design should feel friendly, direct, and structured rather than luxurious or cinematic. Orange should identify the key number, node, bar, or banner in each scene; the rest stays black, white, gray, or warm neutral. …',
    },
  },
  {
    id: '242f1a73-713b-5e6f-aea5-df7c370ac5da',
    name: 'Crimson Night Glass',
    style: {
      colors: [
        { role: 'background', value: '#0A0A0A' },
        { role: 'glow', value: '#8B0000' },
        { role: 'accent', value: '#CC0000' },
        { role: 'text', value: '#FFFFFF' },
      ],
      fonts: [
        { role: 'heading', family: 'Anton' },
        { role: 'body', family: 'Inter' },
        { role: 'Chinese heading', family: 'Douyin Meihao Ti' },
        { role: 'Chinese body', family: 'Noto Sans SC' },
      ],
      styleGuide: 'MOTION Dark premium entrance — elements emerge from darkness. Title textShadow red glow pulses subtly. Bars fill with red glow. Spring(damping:20, stiffness:90) smooth premium settle. Rounded glass-card panels fade in. Timeline line draws left-to-right red gradient. Stagger 20f between groups. Exit: elements dim into darkness last 20f. COLOR Near-black #0A0A0A with dark red ambient glow #8B0000 (radial gradient upper area). Text white #FFFFFF with red textShadow on title. …',
    },
  },
  {
    id: 'dd6428ed-41e3-5eb0-92b6-9fbf69c96898',
    name: 'Jewel Deco',
    style: {
      colors: [
        { role: 'background', value: '#1A1012' },
        { role: 'coral', value: '#C44D3F' },
        { role: 'gold', value: '#C9A84C' },
        { role: 'teal', value: '#2E7A7A' },
        { role: 'burgundy', value: '#8B2252' },
        { role: 'pink', value: '#D4728A' },
        { role: 'text', value: '#F0E6D0' },
      ],
      fonts: [
        { role: 'heading', family: 'Playfair Display' },
        { role: 'body', family: 'Playfair Display' },
        { role: 'Chinese', family: 'Noto Serif TC' },
      ],
      styleGuide: 'MOTION Opulent reveal — spring(damping:24, stiffness:65, mass:1.3). Decorative frame border draws first (strokeDashoffset over 40f). Content fades in within frame. Stagger: frame border 0f, title 20f, content groups 40f intervals. Bars fill with warm gradient. Timeline nodes scale-up with slight rotation. Exit: opacity→0 + scale 1→0.96, last 24f. COLOR Background near-black warm #1A1012. Jewel-tone: coral #C44D3F, gold #C9A84C, teal #2E7A7A, burgundy #8B2252, pink #D4728A. …',
    },
  },
];

export const findPreset = (id: string): DesignPreset | undefined =>
  DESIGN_STYLE_PRESETS.find((p) => p.id === id);
