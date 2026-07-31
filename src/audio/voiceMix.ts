export interface VoiceMixGains {
  dry: number;
  wet: number;
}

/** Isolation strength is a non-destructive equal-power dry/wet control. */
export function voiceIsolationMix(strength: number | null | undefined): VoiceMixGains {
  const wet = Math.max(0, Math.min(1, (strength ?? 100) / 100));
  if (wet === 0) return { dry: 1, wet: 0 };
  if (wet === 1) return { dry: 0, wet: 1 };
  return {
    dry: Math.cos(wet * Math.PI / 2),
    wet: Math.sin(wet * Math.PI / 2),
  };
}
