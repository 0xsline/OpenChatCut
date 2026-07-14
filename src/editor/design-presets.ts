// Built-in design-style presets — the local analog of the source
// `router.chatcut.io/public-api/design-styles/catalog` (24 styles). These entries
// are REAL source data captured from the live catalog (names, colors, fonts,
// motion styleGuides verbatim), not invented — roles are free-form, exactly as the
// source ships them ("accent copper", "text secondary", "Chinese heading", …).
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
      styleGuide:
        '暖橘职场编辑风:陶土背景 + 铜/琥珀/棕褐点缀 + 白字,Montserrat 结构 + Playfair 斜体强调,双栏布局。' +
        'MOTION: 入场 spring(damping:28, stiffness:60, mass:1.4) 沉稳落定;柱状 spring(damping:30, stiffness:50, mass:1.6) 每根错开 +12f;小元素 spring(damping:18, stiffness:140, mass:0.7)。整体克制、有重量。',
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
        { role: 'Chinese body', family: 'OPPO Sans' },
        { role: 'Chinese quote', family: 'Huxiaobo Nanshen Ti' },
      ],
      styleGuide: '复古双色印刷风:暖奶油纸底、严格深蓝与红橙双色、Anton 展示字 + Inter 正文 + Dancing Script 引语。',
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
        { role: 'Chinese body', family: 'OPPO Sans' },
      ],
      styleGuide: '笔记学习风:淡青纸面、荧光笔黄强调、方格纸底 + 便利贴,手写体标题 Caveat。',
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
      styleGuide: '柔和有机渐变风:米白背景、暖橘/柔绿有机色块、Playfair 标题 + Inter 正文,气质温和舒展。',
    },
  },
];

export const findPreset = (id: string): DesignPreset | undefined =>
  DESIGN_STYLE_PRESETS.find((p) => p.id === id);
