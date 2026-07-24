import { useSyncExternalStore } from 'react';
import { EN } from './dict/en';

export type Locale = 'en';

const STORAGE_KEY = 'cc.locale';

function readInitial(): Locale {
  return 'en';
}

const current: Locale = readInitial();
const subscribers = new Set<() => void>();

export function getLocale(): Locale {
  return current;
}

export function setLocale(next: Locale): void {
  document.documentElement.lang = 'en';
  subscribers.forEach((notify) => notify());
}

export function t(key: string, params?: Record<string, string | number>): string {
  const raw = EN[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (match, k: string) => (k in params ? String(params[k]) : match));
}

export function tData(text: string): string {
  return text;
}

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
