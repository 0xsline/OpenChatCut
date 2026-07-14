// Source sound-effect library (ChatCut-owned; from the reverse dump's
// sound-library/sounds.json + 35 mp3s in public/sound-effects/<id>.mp3).
// Click a card in the 音效 tab → drops the SFX on an audio track.

export interface SoundEffect { id: string; name: string; group: string; seconds: number; desc: string; popular: boolean; }
export interface SoundGroup { id: string; name: string; }

export const SOUND_GROUPS: SoundGroup[] = [
  { id: 'ui-motion-feedback', name: 'UI & Motion Feedback' },
  { id: 'transition-emphasis', name: 'Transition & Emphasis' },
  { id: 'device-texture', name: 'Device & Texture' },
  { id: 'reaction-mood', name: 'Reaction & Mood' },
];

export const SOUND_EFFECTS: SoundEffect[] = [
  { id: 'tiny-bubble-pop', name: 'Tiny Bubble Pop', group: 'ui-motion-feedback', seconds: 0.134, desc: '极短气泡 pop，适合 MG 卡片、贴纸、提示气泡或小组件弹出。', popular: true },
  { id: 'synthetic-bubble-pop', name: 'Synthetic Bubble Pop', group: 'ui-motion-feedback', seconds: 0.319, desc: '更有设计感的合成气泡声，适合卡片弹出、按钮反馈、轻快的 MG 元素出现。', popular: false },
  { id: 'keyboard-typing-loop', name: 'Keyboard Typing Loop', group: 'ui-motion-feedback', seconds: 15.534, desc: '连续键盘输入声，适合展示搜索、输入代码、填写表单、打字机式出现文字等场景。', popular: false },
  { id: 'slow-dell-keyboard-typing', name: 'Slow Dell Keyboard Typing', group: 'ui-motion-feedback', seconds: 68.323, desc: '慢速真实键盘输入声，适合办公、代码、搜索或屏幕录制感、打字机式出现文字等场景。', popular: true },
  { id: 'mouse-click', name: 'Mouse Click', group: 'ui-motion-feedback', seconds: 0.201, desc: '清晰鼠标点击声，适合按钮点击、选中、工具切换、教程演示里的操作反馈。', popular: true },
  { id: 'new-notification-ping', name: 'New Notification Ping', group: 'ui-motion-feedback', seconds: 0.504, desc: '短促的新消息提醒声，适合消息弹出、状态更新、提示卡片出现。', popular: true },
  { id: 'ui-pop-up-alert', name: 'UI Pop-up Alert', group: 'ui-motion-feedback', seconds: 0.377, desc: 'UI 弹窗/提醒感音效，适合弹出文字、弹出提示、消息卡片、轻量状态变化。', popular: false },
  { id: 'phone-notification-ping', name: 'Phone Notification Ping', group: 'ui-motion-feedback', seconds: 0.783, desc: '手机通知提示音，适合消息弹出、手机界面演示、社交应用通知。', popular: false },
  { id: 'sent-message-ping', name: 'Sent Message Ping', group: 'ui-motion-feedback', seconds: 0.358, desc: '发送消息的短提示音，适合卡片弹出、聊天发送、表单提交、任务完成等轻量确认反馈。', popular: true },
  { id: 'video-call-ringtone', name: 'Video Call Ringtone', group: 'ui-motion-feedback', seconds: 3.435, desc: '视频来电铃声，适合电话/视频通话场景、消息未接、社交应用提示。', popular: false },
  { id: 'clean-ding', name: 'Clean Ding', group: 'ui-motion-feedback', seconds: 1.632, desc: '干净的叮声提示，适合成功、完成、提示、选中或轻量奖励反馈、也适合重点强调。', popular: true },
  { id: 'censor-beep', name: 'Censor Beep', group: 'ui-motion-feedback', seconds: 0.751, desc: '用于遮盖脏话或敏感词的消音哔声。', popular: true },
  { id: 'cash-register-success', name: 'Cash Register Success', group: 'ui-motion-feedback', seconds: 2.034, desc: '收银机/成交提示声，适合口播里的价格、金额、数字展示强调。', popular: false },
  { id: 'simple-whoosh', name: 'Simple Whoosh', group: 'transition-emphasis', seconds: 1.292, desc: '短促干净的飞入/切换扫过声，适合卡片、字幕、镜头或元素快速移动时做转场强调。', popular: true },
  { id: 'deep-short-whoosh', name: 'Deep Short Whoosh', group: 'transition-emphasis', seconds: 1.314, desc: '偏低沉、干声的短 whoosh，适合更有重量感的镜头切换、元素入场或重点信息出现。', popular: false },
  { id: 'airy-short-whoosh', name: 'Airy Short Whoosh', group: 'transition-emphasis', seconds: 0.757, desc: '较轻、偏空气感的短 whoosh，适合转场、轻量卡片、贴纸、字幕或 UI 元素滑入滑出。', popular: true },
  { id: 'long-suspense-riser', name: 'Long Suspense Riser', group: 'transition-emphasis', seconds: 3.737, desc: '较长的上升铺垫声，适合悬念建立、信息揭晓、倒计时结束或大段落转场前的情绪拉升。', popular: false },
  { id: 'fast-suspense-riser', name: 'Fast Suspense Riser', group: 'transition-emphasis', seconds: 4.375, desc: '速度感更强的悬念 riser，适合短视频里快速制造期待，然后接一个答案、反转或画面切换。', popular: false },
  { id: 'sharp-bass-riser', name: 'Sharp Bass Riser', group: 'transition-emphasis', seconds: 0.891, desc: '很短的低频上升提示，适合在冲击、切点、标题弹出前做一小段快速铺垫，也可以作为转场', popular: true },
  { id: 'short-drum-roll-sting', name: 'Short Drum Roll Sting', group: 'transition-emphasis', seconds: 0.704, desc: '很短的滚鼓提示，适合答案揭晓、排名公布、转折前的小悬念，也适合转场或者有重点要强调、信息要弹出。', popular: false },
  { id: 'record-scratch-stop', name: 'Record Scratch Stop', group: 'transition-emphasis', seconds: 0.636, desc: '唱片刮擦/急停感音效，适合突然打断、倒放倒带、时间回退或喜剧转场。', popular: true },
  { id: 'record-scratch-rewind', name: 'Record Scratch Rewind', group: 'transition-emphasis', seconds: 1.446, desc: '更长一点的 record scratch 变体，适合视频倒放、回到前一刻、突然反悔或喜剧打断。', popular: false },
  { id: 'camera-shutter', name: 'Camera Shutter', group: 'device-texture', seconds: 0.42, desc: '标准相机快门声，适合拍照、截图、画面定格、证据展示等视觉动作。', popular: false },
  { id: 'vintage-camera-shutter', name: 'Vintage Camera Shutter', group: 'device-texture', seconds: 0.327, desc: '复古相机快门声，适合图片素材切换、证据截图、旧片感定格或复古相册。', popular: false },
  { id: 'short-shutter-click', name: 'Short Shutter Click', group: 'device-texture', seconds: 0.194, desc: '很短的快门/点击声，适合轻量拍照反馈、截图、卡片捕捉或快速定格，也可以用于转场。', popular: true },
  { id: 'mechanical-clicking-loop', name: 'Mechanical Clicking Loop', group: 'device-texture', seconds: 2.904, desc: '机械连续点击/运转感音效，适合齿轮、机关、设备启动、机械动画或工业质感画面。', popular: false },
  { id: 'gear-turn-click', name: 'Gear Turn Click', group: 'device-texture', seconds: 0.635, desc: '短齿轮/机械卡扣声，适合数字滚动、同类元素切换（比如多张照片）。', popular: false },
  { id: 'light-clock-tick', name: 'Light Clock Tick', group: 'device-texture', seconds: 50.274, desc: '轻时钟滴答声，适合等待、倒计时、时间流逝、紧张但不夸张的段落。', popular: false },
  { id: 'glitchy-tv-signal', name: 'Glitchy TV Signal', group: 'device-texture', seconds: 0.956, desc: 'Choppy TV static and bad signal texture for device glitches, MG motion', popular: false },
  { id: 'tv-switch-off-noise', name: 'TV Switch Off Noise', group: 'device-texture', seconds: 0.199, desc: 'Short TV switch-off noise for screen shutdowns, signal cuts, MG disapp', popular: false },
  { id: 'vine-boom-impact', name: 'Vine Boom Impact', group: 'reaction-mood', seconds: 2.875, desc: '经典低频 boom 冲击声，适合震惊、反转、夸张表情、重点字幕或画面突然停顿。', popular: true },
  { id: 'dramatic-thunder-roll', name: 'Dramatic Thunder Roll', group: 'reaction-mood', seconds: 8.142, desc: '用于情绪烘托的雷声，不作为环境氛围长音使用。适合震惊反应、坏消息或悬念段落。', popular: false },
  { id: 'anime-wow-reaction', name: 'Anime Wow Reaction', group: 'reaction-mood', seconds: 3.707, desc: '偏动漫/综艺的正向 wow 反应声，适合物品展示、人物亮相、隆重登场、揭幕或发现亮点的惊喜时刻。', popular: true },
  { id: 'awkward-crow-flyby', name: 'Awkward Crow Flyby', group: 'reaction-mood', seconds: 1.72, desc: '乌鸦飞过式冷场音效，适合尴尬沉默、笑话失败、没人回应的综艺反应。', popular: false },
  { id: 'sitcom-laugh-track', name: 'Sitcom Laugh Track', group: 'reaction-mood', seconds: 2.459, desc: '情景剧/综艺笑声音效，适合包袱落点、搞笑片段、夸张反应后补充笑果。', popular: false },
];

/** public URL for a sound effect's audio file */
export const soundEffectSrc = (id: string): string => `/sound-effects/${id}.mp3`;
