// EN 词典装配(单一真源):按领域分文件,键=中文原文,值=英文。
// 每个领域文件由对应扫换工作线独占填写,互不触碰,避免合并冲突。
import audio from './audio';
import captions from './captions';
import chat from './chat';
import components from './components';
import editor from './editor';
import exportPanel from './exportPanel';
import fx from './fx';
import generate from './generate';
import library from './library';
import media from './media';
import progress from './progress';
import script from './script';
import settings from './settings';
import timeline from './timeline';
import topbar from './topbar';
import transcript from './transcript';

export const EN: Record<string, string> = Object.assign(
  {},
  audio, captions, chat, components, editor, exportPanel, fx, generate,
  library, media, progress, script, settings, timeline, topbar, transcript,
);
