import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { AbsoluteFill, cancelRender, continueRender, delayRender } from 'remotion';
import { collectReferencedFontFaces, loadTimelineFonts } from '../fonts/projectFonts';
import { prepareTemplate } from '../template-host';
import type { TimelineState } from './types';

interface TimelineReadinessGateProps {
  state: TimelineState;
  dependencies?: readonly TimelineState[];
  children: () => ReactNode;
}

export function timelineReadinessKey(state: TimelineState, dependencies: readonly TimelineState[] = []): string {
  const states = [state, ...dependencies];
  const templates = states.flatMap((entry) => entry.items
    .filter((item) => item.kind === 'motion-graphic' && item.code)
    .map((item) => item.code as string));
  return JSON.stringify([states.flatMap(collectReferencedFontFaces), templates]);
}

function prepareTimelineTemplates(state: TimelineState): Promise<void> {
  const templates = state.items.filter((item) => item.kind === 'motion-graphic' && item.code);
  return Promise.all(templates.map(async (item) => {
    try {
      await prepareTemplate(item.code as string);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${item.name} — compile error:\n${message}`);
    }
  })).then(() => undefined);
}

export function TimelineReadinessGate({ state, dependencies = [], children }: TimelineReadinessGateProps) {
  const [readinessStates] = useState(() => [state, ...dependencies]);
  const [handle] = useState(() => delayRender('Preparing project fonts and templates'));
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let continued = false;
    const release = () => {
      if (continued) return;
      continued = true;
      continueRender(handle);
    };
    const fail = (reason: unknown) => {
      if (continued) return;
      continued = true;
      const readinessError = reason instanceof Error ? reason : new Error(String(reason));
      if (active) setError(readinessError.message);
      try {
        cancelRender(readinessError);
      } catch {
        // The Player keeps the explicit error UI above; headless rendering is already cancelled.
      }
    };
    Promise.resolve()
      .then(() => Promise.all(readinessStates.flatMap((entry) => [loadTimelineFonts(entry), prepareTimelineTemplates(entry)])))
      .then(
      () => { if (active) setReady(true); release(); },
      (reason: unknown) => fail(reason),
    );
    return () => { active = false; release(); };
  }, [handle, readinessStates]);

  if (error) return <AbsoluteFill style={{ color: '#f88', fontFamily: 'monospace', fontSize: 20, padding: 40, whiteSpace: 'pre-wrap' }}>{error}</AbsoluteFill>;
  return ready ? children() : null;
}
