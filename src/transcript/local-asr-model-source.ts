export function localAsrModelHosts(origin: string): readonly [string] {
  const parsed = new URL(origin);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported local ASR origin protocol: ${parsed.protocol}`);
  }
  return [`${parsed.origin}/api/hf-proxy`];
}

export function localAsrLoadError(reason: unknown): Error {
  const detail = reason instanceof Error ? reason.message : String(reason);
  return new Error(`Local ASR model load failed; remote fallback is disabled: ${detail}`);
}
