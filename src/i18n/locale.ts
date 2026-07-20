// 语言状态 + t():中文原文即键(不另造 key 命名空间),en 词典查不到回退中文,
// 永不白屏。切换持久化 localStorage('cc.locale'),订阅式重渲(useSyncExternalStore)。
// 规矩:React 组件里用 useT()(订阅切换);纯 helper 模块可直接 import { t }
// ——只要渲染它输出的组件自己调用了 useT(),切语言时就会连带重算。
// LLM 面(systemPrompt/工具描述/技能内容)与持久化的动态历史标签不进 i18n。
import { useSyncExternalStore } from 'react';
import { EN } from './dict/en';
import EN_DATA from './dict/en/templates-data';
import { ZH_DATA } from './dict/zh';

export type Locale = 'zh' | 'en';

const STORAGE_KEY = 'cc.locale';

function readInitial(): Locale {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

let current: Locale = readInitial();
const subscribers = new Set<() => void>();

export function getLocale(): Locale {
  return current;
}

export function setLocale(next: Locale): void {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch { /* 私隐模式等存不了就只影响本次会话 */ }
  document.documentElement.lang = next === 'en' ? 'en' : 'zh-CN';
  subscribers.forEach((notify) => notify());
}

/** t('已选 {n}', { n: 3 }) —— 中文原文即键;占位符 {name} 两种语言同名。 */
export function t(zh: string, params?: Record<string, string | number>): string {
  const raw = current === 'en' ? (EN[zh] ?? zh) : zh;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (match, key: string) => (key in params ? String(params[key]) : match));
}

/** 双向数据本地化:**数据**名(模板名等)按当前语言查表显示,查不到原样返回。
 * 英文键数据(内置 211 条)zh 态走 ZH_DATA;中文键数据(自制包)en 态走 EN_DATA。
 * 只用于展示,不改数据本身(名字同时是引用键)。 */
export function tData(text: string): string {
  return current === 'zh' ? (ZH_DATA[text] ?? text) : (EN_DATA[text] ?? text);
}

/** 组件内取 t:订阅语言切换,切换时触发本组件重渲。 */
export function useT(): typeof t {
  useSyncExternalStore(
    (onChange) => {
      subscribers.add(onChange);
      return () => subscribers.delete(onChange);
    },
    () => current,
  );
  return t;
}
