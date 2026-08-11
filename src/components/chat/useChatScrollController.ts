import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { DisplayMessage } from '../../agent/agent-session';
import type { AgentController } from '../../agent/useAgent';
import { resolveChatScrollTarget, type ChatScrollTarget } from './chatScrollNavigation';
import { selectChatMessageContents, shouldHandleChatTextSelection } from './chatTextSelection';

const CHAT_SCROLL_NAV_IDLE_MS = 900;
/** Scrolling out of this many px from the bottom means the user left the latest
 *  content, so streaming new replies should not yank the view back to bottom. */
const CHAT_AUTO_FOLLOW_MARGIN = 48;
interface MutableValue<T> { current: T }

export interface ChatScrollController {
  scrollRef: MutableValue<HTMLDivElement | null>;
  target: ChatScrollTarget | null;
  onScroll: () => void;
  scrollTo: (target: ChatScrollTarget) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  hide: () => void;
  sampleRef: MutableValue<{ top: number; time: number }>;
  suppressUntilRef: MutableValue<number>;
  timerRef: MutableValue<number | null>;
  /** Whether the view should keep auto-following the newest reply. Disabled while
   *  the user scrolls away from the bottom, re-enabled once they return to it. */
  autoFollowRef: MutableValue<boolean>;
}

export function useChatScrollController(): ChatScrollController {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<ChatScrollTarget | null>(null);
  const sampleRef = useRef({ top: 0, time: 0 });
  const timerRef = useRef<number | null>(null);
  const suppressUntilRef = useRef(0);
  const autoFollowRef = useRef(true);
  const hide = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setTarget(null);
  }, []);
  const onScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const current = { top: node.scrollTop, time: performance.now() };
    const next = resolveChatScrollTarget({
      previous: sampleRef.current, current, scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight, suppressUntil: suppressUntilRef.current,
    });
    sampleRef.current = current;
    // Re-evaluate whether the user is still viewing the newest content: if they
    // have scrolled up past the bottom margin (e.g. to read history while the
    // agent streams), stop auto-following so new replies don't yank the view back.
    const remainingBottom = node.scrollHeight - node.clientHeight - node.scrollTop;
    if (autoFollowRef.current && remainingBottom > CHAT_AUTO_FOLLOW_MARGIN) {
      autoFollowRef.current = false;
    } else if (!autoFollowRef.current && remainingBottom <= CHAT_AUTO_FOLLOW_MARGIN) {
      autoFollowRef.current = true;
    }
    if (!next) return;
    setTarget(next);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setTarget(null);
    }, CHAT_SCROLL_NAV_IDLE_MS);
  }, []);
  const scrollTo = useCallback((next: ChatScrollTarget) => {
    const node = scrollRef.current;
    if (!node) return;
    suppressUntilRef.current = performance.now() + 1200;
    if (next === 'bottom') autoFollowRef.current = true;
    hide();
    node.scrollTo({ top: next === 'top' ? 0 : node.scrollHeight, behavior: 'smooth' });
  }, [hide]);
  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (!(event.target instanceof HTMLElement)) return;
    if (!shouldHandleChatTextSelection(event, event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    selectChatMessageContents(scrollRef.current);
  }, []);
  return {
    scrollRef,
    target,
    onScroll,
    scrollTo,
    onKeyDown,
    hide,
    sampleRef,
    suppressUntilRef,
    timerRef,
    autoFollowRef,
  };
}

export function useChatAutoScroll(
  scroll: ChatScrollController,
  messages: DisplayMessage[],
  running: boolean,
  proposal: AgentController['proposal'],
): void {
  const {
    scrollRef,
    suppressUntilRef,
    hide,
    sampleRef,
    timerRef,
    autoFollowRef,
  } = scroll;
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    // Only keep following the newest reply if the user hasn't scrolled up to read
    // history. If they have (autoFollowRef === false), leave the view where it is.
    if (!autoFollowRef.current) return;
    suppressUntilRef.current = performance.now() + 120;
    hide();
    node.scrollTo({ top: node.scrollHeight });
    const frame = requestAnimationFrame(() => {
      sampleRef.current = { top: node.scrollTop, time: performance.now() };
    });
    return () => cancelAnimationFrame(frame);
  }, [hide, messages, proposal, running, sampleRef, scrollRef, suppressUntilRef, autoFollowRef]);
  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, [timerRef]);
}
