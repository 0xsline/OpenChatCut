// Built-in design-style presets — the local analog of the source
// `/api/design-styles/owned` library (manage_design_style, action="list").
// Each preset is a full DesignStyle (source designSpec: colors[role,value] +
// fonts[family,role] + styleGuide). Fonts are web-safe / caption-preset families
// so they render without extra loading.
import type { DesignStyle } from './types';

export interface DesignPreset {
  id: string;
  name: string;
  style: DesignStyle;
}

export const DESIGN_STYLE_PRESETS: DesignPreset[] = [
  {
    id: 'noir-gold',
    name: '极简黑金',
    style: {
      colors: [
        { role: 'primary', value: '#E6AC42' },
        { role: 'secondary', value: '#8F8F8F' },
        { role: 'accent', value: '#F0562E' },
        { role: 'background', value: '#070707' },
        { role: 'text', value: '#F5EFE3' },
      ],
      fonts: [
        { family: 'Playfair Display', role: 'heading' },
        { family: 'Inter', role: 'body' },
      ],
      styleGuide: '高级、克制。大标题用衬线，正文干净无衬线;金色只做点睛,不铺满。',
    },
  },
  {
    id: 'vivid-pop',
    name: '活力撞色',
    style: {
      colors: [
        { role: 'primary', value: '#FF2D78' },
        { role: 'secondary', value: '#00E83C' },
        { role: 'accent', value: '#FFEC1A' },
        { role: 'background', value: '#0A0A0A' },
        { role: 'text', value: '#FFFFFF' },
      ],
      fonts: [
        { family: 'Bowlby One', role: 'heading' },
        { family: 'Mulish', role: 'body' },
      ],
      styleGuide: '短视频/口播风。粗描边大字、饱和撞色、节奏快;适合 TikTok 竖屏。',
    },
  },
  {
    id: 'soft-magazine',
    name: '柔和杂志',
    style: {
      colors: [
        { role: 'primary', value: '#B64A3B' },
        { role: 'secondary', value: '#24120A' },
        { role: 'accent', value: '#F6C239' },
        { role: 'background', value: '#FFF1DA' },
        { role: 'text', value: '#24120A' },
      ],
      fonts: [
        { family: 'Fraunces', role: 'heading' },
        { family: 'Newsreader', role: 'body' },
      ],
      styleGuide: '暖色纸感、编辑排版。留白多、字距舒展;像纸媒专题。',
    },
  },
  {
    id: 'tech-cool',
    name: '科技冷调',
    style: {
      colors: [
        { role: 'primary', value: '#4DFFDF' },
        { role: 'secondary', value: '#6EE7F9' },
        { role: 'accent', value: '#A3FF12' },
        { role: 'background', value: '#061016' },
        { role: 'text', value: '#EAFBFF' },
      ],
      fonts: [
        { family: 'Unbounded', role: 'heading' },
        { family: 'Sora', role: 'body' },
      ],
      styleGuide: '产品/科技发布风。深底、青绿霓虹、几何无衬线;发光点缀,信息密度高。',
    },
  },
];

export const findPreset = (id: string): DesignPreset | undefined =>
  DESIGN_STYLE_PRESETS.find((p) => p.id === id);
