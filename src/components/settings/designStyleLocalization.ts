import { DESIGN_STYLE_PRESETS } from '../../editor/design-presets';
import type { Locale } from '../../i18n/locale';

const PRESET_NAME_ZH: Record<string, string> = {
  'Terracotta Editorial': '陶土杂志风',
  'Retro Duotone Print': '复古双色印刷',
  'Highlighter Notebook': '荧光笔记本',
  'Soft Organic Gradient': '柔和有机渐变',
  'Doodle Explainer': '手绘讲解风',
  'Emerald Deco': '翡翠装饰艺术',
  'Black Yellow Type': '黑黄字体风',
  'Electric Impact Type': '电光冲击字体',
  'Acid Script Poster': '酸性手写海报',
  'Neon Grid Commerce': '霓虹网格商业风',
  'Pale Tech Dashboard': '浅色科技仪表盘',
  'Liquid Aura': '流光氛围',
  'Grainy Heatwave': '颗粒热浪',
  'Blush Watercolor': '腮红水彩',
  'Archive Typewriter': '档案打字机',
  'Cubist Collage': '立体主义拼贴',
  'Redline Tech': '红线科技',
  'Black & White Neon': '黑白霓虹',
  'Violet Aura': '紫罗兰光晕',
  'Warm Paper': '暖调纸张',
  'Modern Editorial': '现代杂志编辑风',
  'Orange Minimal': '橙色极简',
  'Crimson Night Glass': '绯红夜色玻璃',
  'Jewel Deco': '宝石装饰艺术',
};

const PRESET_GUIDE_ZH: Record<string, string> = {
  'Terracotta Editorial': '陶土杂志风：沉稳的弹簧入场与分组错峰动画，标题、姓名、要点和时间轴分别从不同方向轻缓进入。以陶土红、铜色和琥珀色为主，搭配白色文字与优雅衬线强调。',
  'Retro Duotone Print': '复古双色印刷：文字采用打字机式逐字出现，图表和时间轴线性生长，不使用透明度或缩放动画。以暖米色为底，只使用深蓝与橙红两种主色。',
  'Highlighter Notebook': '荧光笔记本：高亮笔划从左向右扫过文字，勾选线条逐步绘制，便签和装饰元素轻快弹入。使用柔和青绿色、白纸、黄色荧光笔与深灰文字。',
  'Soft Organic Gradient': '柔和有机渐变：奶油白画布搭配桃色和鼠尾草绿渐变色块，动画平滑克制、不反弹。使用衬线斜体章节号、衬线大标题和清晰的无衬线正文。',
  'Doodle Explainer': '手绘讲解风：元素以轻快弹跳方式出现，手绘星号、叉号和边框依次绘制。暖白底色搭配深蓝与红色，适合亲切、轻松的知识讲解。',
  'Emerald Deco': '翡翠装饰艺术：标题、图表和时间轴以柔和弹簧动画进入，金色线条从中心展开。深翡翠绿背景搭配奶油色文字和哑金装饰，整体典雅稳重。',
  'Black Yellow Type': '黑黄字体风：标题从遮罩中上滑，图表与时间轴直接、利落地展开。只使用纯黑、亮黄两种主色，避免灰色和渐变，形成强烈的排版冲击。',
  'Electric Impact Type': '电光冲击字体：文字逐词硬切出现，图表和节点按顺序直接显现。深电光蓝背景搭配纯红和白色，适合节奏强、信息密集的标题与数据展示。',
  'Acid Script Poster': '酸性手写海报：标题逐字出现，并混合窄体字和装饰手写体；曲线装饰逐步绘制。荧光黄绿色背景搭配纯黑文字与白色徽章，具有实验海报感。',
  'Neon Grid Commerce': '霓虹网格商业风：内容以网格卡片形式弹入，霓虹边框和图表线性生长，注释使用等宽字体逐字出现。黑色背景搭配荧光黄绿和白色正文。',
  'Pale Tech Dashboard': '浅色科技仪表盘：近白背景搭配紫蓝柔光色块，数字轻微缩放进入，图表平滑生长。使用等宽标题、像素数字和清晰正文，呈现技术感与数据感。',
  'Liquid Aura': '流光氛围：深紫蓝背景中加入持续缓慢流动的紫色、洋红和蓝色光团，文字平滑进入，进度环和指标逐步绘制。整体沉浸、流动且富有氛围。',
  'Grainy Heatwave': '颗粒热浪：元素从噪点纹理中逐渐显现，节奏缓慢、梦幻，图表使用高饱和橙色和洋红色。背景采用橙紫渐变与明显颗粒，文字保持纯白。',
  'Blush Watercolor': '腮红水彩：粉红、蓝色和桃色水彩晕染缓慢铺开，文字与图表柔和进入，线条自然绘制。使用轻盈衬线标题和清晰正文，呈现手绘、有机质感。',
  'Archive Typewriter': '档案打字机：所有文字按打字机节奏逐字出现，图表和时间轴线性绘制，元素依次登场。暖羊皮纸背景搭配黑色文字和暖金色强调。',
  'Cubist Collage': '立体主义拼贴：色块从中心弹入，文字从不同方向滑入，三角形、菱形和圆形装饰旋转出现。以奶油白为底，使用蓝、黄、红、青和橙等饱和色。',
  'Redline Tech': '红线科技：深炭黑表面、点阵纹理、锐利红色面板与斜向切换构成工业科技语言。红色负责焦点动作，白色承载主要内容，灰色仅用于次要信息。',
  'Black & White Neon': '黑白霓虹：近黑背景搭配发光白字、白色圆环、折线和描边，少量冷紫色只作为辅助光晕。每个画面保留一个明确焦点，并留出充足安静空间。',
  'Violet Aura': '紫罗兰光晕：深紫黑背景、紫粉渐变光晕、半透明大数字与圆角卡片共同形成梦幻解释风。每个画面围绕一个核心问题、数字、图表或语句展开。',
  'Warm Paper': '暖调纸张：奶油色纸张、细腻纹理、珊瑚橙强调、有机波浪与鹅卵石徽章组成温暖杂志风。衬线标题负责情绪，珊瑚色只标记真正的焦点。',
  'Modern Editorial': '现代杂志编辑风：暖灰纸张、笔记本或报刊网格、衬线标题与清晰的 Roboto 正文。整体像数据记者的批注笔记，以黑灰为主，仅用橙色或黄色强调关键数值和语句。',
  'Orange Minimal': '橙色极简：纸张质感的中性色背景、扁平几何块、粗体排版、编号徽章和简洁图表组成友好直接的商业解释风。橙色只用于关键数字、节点或横幅。',
  'Crimson Night Glass': '绯红夜色玻璃：元素从暗处柔和进入，标题和图表带克制红色辉光，圆角玻璃卡片逐步显现。近黑背景搭配暗红环境光与白色正文，适合高级暗调展示。',
  'Jewel Deco': '宝石装饰艺术：装饰边框先绘制，内容随后分组淡入，图表使用温暖渐变并带轻微旋转。近黑暖色背景搭配珊瑚、金色、青色、酒红和粉色宝石色调。',
};

const ROLE_ZH: Record<string, string> = {
  primary: '主色',
  secondary: '辅色',
  accent: '强调色',
  background: '背景',
  text: '文字',
  'text secondary': '次要文字',
  'text-secondary': '次要文字',
  'text-on-dark': '深色背景文字',
  heading: '标题字体',
  body: '正文字体',
  quote: '引用字体',
  display: '展示字体',
  'display number': '数字展示字体',
  mono: '等宽字体',
  script: '手写字体',
  'heading serif': '衬线标题字体',
  Chinese: '中文字体',
  'Chinese heading': '中文标题字体',
  'Chinese body': '中文正文字体',
  'Chinese accent': '中文强调字体',
  'Chinese quote': '中文引用字体',
  'accent copper': '强调铜色',
  'accent amber': '强调琥珀色',
  'accent tan': '强调棕褐色',
  'accent gradient start': '强调渐变起始色',
  'accent gradient end': '强调渐变结束色',
  'accent-red': '强调红色',
  'accent-red-dark': '深强调红色',
  'accent-red-panel': '面板强调红色',
  'accent-red-vivid': '鲜艳强调红色',
  axis: '坐标轴',
  'background-chart': '图表背景',
  'background-neutral': '中性背景',
  'background-warm': '暖色背景',
  'background gradient start': '背景渐变起始色',
  'background gradient end': '背景渐变结束色',
  'chart-warm-light': '图表暖色浅调',
  'chart-warm-mid': '图表暖色中间调',
  'chart-warm-dark': '图表暖色深调',
  'chart-warm-deep': '图表暖色最深调',
  'chart accent 1': '图表强调色 1',
  'chart accent 2': '图表强调色 2',
  'chart accent 3': '图表强调色 3',
  highlight: '高亮色',
  badge: '徽章色',
  callout: '标注色',
  divider: '分隔线',
  grid: '网格线',
  paper: '纸张色',
  sticky: '便签色',
  texture: '纹理色',
  glow: '光晕色',
  'glow-main': '主光晕',
  'glow-soft': '柔光晕',
  'inner-glow': '内发光',
  'meta-text': '辅助文字',
  impact: '冲击色',
  neon: '霓虹色',
  'price-card': '价格卡片',
  'blob blue': '蓝色光团',
  'blob deep purple': '深紫光团',
  'blob green': '绿色光团',
  'blob magenta': '洋红光团',
  'blob purple': '紫色光团',
  'blob warm': '暖色光团',
  'wash blue': '蓝色水彩',
  'wash flower': '花朵水彩',
  'wash peach': '桃色水彩',
  'wash pink': '粉色水彩',
  burgundy: '酒红色',
  cobalt: '钴蓝色',
  coral: '珊瑚色',
  gold: '金色',
  orange: '橙色',
  pink: '粉色',
  red: '红色',
  teal: '青绿色',
  yellow: '黄色',
};

const FONT_ROLE_ZH: Record<string, string> = {
  ...ROLE_ZH,
  accent: '强调字体',
  callout: '标注字体',
  impact: '冲击字体',
};

const GUIDE_ZH_BY_SOURCE = new Map(
  DESIGN_STYLE_PRESETS
    .filter((preset) => preset.style.styleGuide && PRESET_GUIDE_ZH[preset.name])
    .map((preset) => [preset.style.styleGuide as string, PRESET_GUIDE_ZH[preset.name]]),
);

export function localizeDesignPresetName(name: string, locale: Locale): string {
  return locale === 'zh' ? (PRESET_NAME_ZH[name] ?? name) : name;
}

export function localizeDesignRole(role: string, locale: Locale): string {
  return locale === 'zh' ? (ROLE_ZH[role] ?? role) : role;
}

export function localizeDesignFontRole(role: string, locale: Locale): string {
  return locale === 'zh' ? (FONT_ROLE_ZH[role] ?? role) : role;
}

export function localizeDesignStyleGuide(guide: string, locale: Locale): string {
  return locale === 'zh' ? (GUIDE_ZH_BY_SOURCE.get(guide) ?? guide) : guide;
}

