interface RoutingGroup {
  readonly requestKeywords?: readonly string[];
  readonly requestContext?: readonly (readonly string[])[];
  readonly mutating?: boolean;
  readonly tools: readonly string[];
}

const EDIT_VERBS = [
  'edit', 'add', 'insert', 'create', 'update', 'modify', 'adjust', 'apply', 'reorder',
  'delete', 'remove', 'trim', 'split', 'move', 'retime', 'slip',
  '编辑', '加', '添加', '新增', '插入', '创建', '修改', '调整', '设置', '应用', '排列', '排序', '重排',
  '删除', '移除', '裁剪', '分割', '移动', '变速', '滑动',
];
const EDIT_TARGETS = [
  'clip', 'item', 'track', 'timeline', 'sequence', 'title', 'text',
  '片段', '轨道', '时间线', '序列', '标题', '文字',
];
const GENERATE_VERBS = [
  'generate', 'create', 'make', 'synthesize', '生成', '创建', '制作', '合成',
];
const GENERATE_TARGETS = [
  'image', 'picture', 'photo', 'poster', 'video', 'music', 'sound', 'voiceover', 'shader',
  '图片', '图像', '照片', '海报', '视频', '音乐', '音效', '配音', '着色器',
];

const ROUTING_GROUPS: readonly RoutingGroup[] = [
  {
    mutating: true,
    requestKeywords: [
      'trim', 'split', 'move clip', 'delete clip', 'remove clip', 'retime', 'slip edit',
      'background fill', 'blur background', 'edit timeline',
      '剪辑', '裁剪', '分割', '移动片段', '删除片段', '移除片段', '变速', '滑动编辑',
      '背景填充', '模糊背景', '虚化背景',
    ],
    requestContext: [EDIT_VERBS, EDIT_TARGETS],
    tools: [
      'update_item_props', 'move_item', 'set_item_timing', 'duplicate_item', 'remove_item',
      'split_item', 'manage_timelines', 'edit_track', 'edit_item', 'undo_last_change',
      'redo_last_change', 'apply_layout',
    ],
  },
  {
    requestKeywords: [
      'aspect ratio', 'canvas ratio', 'vertical video', 'landscape video',
      '画幅', '横转竖', '竖转横', '视频比例', '画布比例',
    ],
    tools: ['set_aspect_ratio', 'apply_layout', 'auto_reframe'],
  },
  {
    requestContext: [
      ['elevenlabs', 'doubao', 'minimax', 'inworld', 'fish audio', 'fishaudio', 'speechify', 'openai', 'gemini', 'mistral', 'cartesia'],
      ['tts', 'text-to-speech', 'speech synthesis', 'voice generation', 'voiceover generation', '配音', '语音合成'],
    ],
    tools: ['submit_voice', 'track_progress', 'rerun_generation'],
  },
  {
    requestContext: [
      ['assemblyai', 'local', 'openai', 'mistral', 'deepgram', 'groq', 'elevenlabs', 'cartesia'],
      ['transcribe', 'transcription', 'speech-to-text', 'stt', 'asr', '转写', '语音识别'],
    ],
    tools: ['transcribe_track', 'read_transcript', 'find_transcript'],
  },
  {
    requestKeywords: ['caption', 'subtitle', 'captions', 'subtitles', '字幕'],
    tools: ['read_captions', 'edit_captions', 'apply_caption_avoidance', 'place_graphics_in_safe_zone'],
  },
  {
    requestKeywords: ['transcript', 'script', 'speech', '文字稿', '台词', '口播', '讲稿'],
    tools: [
      'read_transcript', 'find_transcript', 'clean_script', 'edit_gap', 'delete_text',
      'manage_transcript', 'read_script', 'apply_script',
    ],
  },
  {
    requestKeywords: ['silence', 'pause', 'filler word', '静音', '停顿', '填充词', '赘词'],
    tools: ['read_transcript', 'find_transcript', 'clean_script', 'edit_gap', 'delete_text', 'remove_silence'],
  },
  {
    requestKeywords: ['audio', 'music', 'sound', 'loudness', 'bgm', '音频', '声音', '音乐', '音效', '响度', '背景音乐'],
    tools: [
      'list_audio', 'add_audio', 'normalize_loudness', 'isolate_voice', 'detect_beats',
      'analyze_music', 'inspect_music', 'music_edit_plan', 'sync_cuts_to_music',
    ],
  },
  {
    requestKeywords: [
      'library', 'template', 'effect', 'transition', 'zoom', 'lut', 'graphic', 'watermark',
      '素材库', '模板', '特效', '转场', '动效', '水印',
    ],
    tools: [
      'list_templates', 'search_templates', 'browse_library', 'manage_effects', 'manage_template',
      'update_watermark', 'search_fonts', 'add_motion_graphic', 'create_motion_graphic',
      'submit_motion_graphic', 'create_motion_graphic_from_code',
    ],
  },
  {
    requestContext: [GENERATE_VERBS, GENERATE_TARGETS],
    tools: [
      'submit_image', 'submit_voice', 'submit_sound', 'submit_music', 'submit_video',
      'submit_shader', 'submit_motion_graphic', 'track_progress', 'rerun_generation',
    ],
  },
  {
    requestKeywords: ['import', 'upload', 'download', 'media', 'asset', 'stock', '素材', '导入', '上传', '下载', '媒体', '版权'],
    tools: [
      'search_media', 'manage_media_pool', 'download_media', 'push_asset', 'import_url_asset',
      'search_stock_media', 'edit_asset', 'import_media', 'finalize_uploaded_asset',
      'request_asset_download', 'probe_media',
    ],
  },
  {
    requestKeywords: ['export', 'render', 'xml', 'prores', 'premiere', 'resolve', '导出', '渲染', '成片'],
    tools: [
      'submit_export', 'submit_render_job', 'track_export', 'read_export_history',
      'verify_export', 'download_media', 'export_motion_graphic_prores',
    ],
  },
  {
    requestKeywords: ['project', 'sequence', 'version', 'marker', 'design style', '项目', '工程', '序列', '版本', '标记', '设计风格'],
    tools: [
      'manage_timelines', 'manage_versions', 'manage_markers', 'manage_design_style', 'list_projects',
      'create_project', 'delete_project', 'restore_project', 'duplicate_project', 'edit_project',
      'target_project', 'get_editor_url',
    ],
  },
  {
    requestKeywords: [
      'scene', 'highlight', 'beat', 'downbeat', 'rhythm', 'multicam', 'reframe', 'color',
      '镜头', '高光', '节拍', '卡点', '重拍', '节奏', '多机位', '重构图', '调色', '分析',
    ],
    tools: [
      'view_timeline_frames', 'view_asset_frames', 'detect_scenes', 'find_highlights', 'auto_reframe',
      'multicam_sync', 'change_cam', 'inspect_color', 'auto_grade', 'detect_beats', 'inspect_music',
      'review_scene_plan',
    ],
  },
  {
    requestKeywords: ['web', 'search', 'crawl', 'website', 'skill', 'code', '网页', '搜索', '抓取', '网站', '技能', '脚本'],
    tools: [
      'web_browser', 'web_search', 'web_map', 'web_crawl', 'web_batch_scrape', 'manage_skill',
      'install_skill', 'run_skill_script', 'run_code', 'search_fonts',
    ],
  },
];
const ROUTING_TERM_PATTERNS = new Map<string, RegExp>();

function routingTermPattern(term: string): RegExp | null {
  if (!/^[a-z][a-z -]*$/.test(term)) return null;
  const cached = ROUTING_TERM_PATTERNS.get(term);
  if (cached) return cached;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let body = escaped;
  if (!term.includes(' ')) {
    if (term.endsWith('e')) body = `${escaped.slice(0, -1)}(?:e|es|ed|ing)`;
    else if (term.endsWith('y')) body = `${escaped.slice(0, -1)}(?:y|ies|ied|ying)`;
    else body = `${escaped}(?:s|ed|ing)?`;
  }
  const pattern = new RegExp(`\\b${body}\\b`);
  ROUTING_TERM_PATTERNS.set(term, pattern);
  return pattern;
}

function requestHasRoutingTerm(request: string, term: string): boolean {
  const pattern = routingTermPattern(term);
  return pattern ? pattern.test(request) : request.includes(term);
}

function routingGroupMatches(group: RoutingGroup, request: string): boolean {
  const direct = group.requestKeywords?.some((term) => requestHasRoutingTerm(request, term)) ?? false;
  const contextual = group.requestContext?.every((alternatives) => (
    alternatives.some((term) => requestHasRoutingTerm(request, term))
  )) ?? false;
  return direct || contextual;
}

/** Shared positive mutation matcher for routing and read-only-hint disambiguation. */
export function hasMutationRoutingIntent(request: string): boolean {
  const normalized = request.toLowerCase();
  return ROUTING_GROUPS.some((group) => group.mutating && routingGroupMatches(group, normalized));
}


const MAX_ROUTING_GROUPS = 4;
export interface RoutedToolSelection {
  readonly names: ReadonlySet<string>;
  readonly matchedGroupCount: number;
  readonly overflow: boolean;
}


export function routedToolSelection(request: string, readOnly: boolean): RoutedToolSelection {
  const normalized = request.toLowerCase();
  const matching = ROUTING_GROUPS.filter((group) => (
    (!group.mutating || !readOnly) && routingGroupMatches(group, normalized)
  ));
  const selected = matching.slice(0, MAX_ROUTING_GROUPS);
  return {
    names: new Set(selected.flatMap((group) => group.tools)),
    matchedGroupCount: matching.length,
    overflow: matching.length > MAX_ROUTING_GROUPS,
  };
}

export function routedToolNames(request: string, readOnly: boolean): ReadonlySet<string> {
  return routedToolSelection(request, readOnly).names;
}
