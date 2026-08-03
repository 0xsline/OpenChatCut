interface DesktopPageOriginOptions {
  embeddedOrigin: string;
  configuredDevUrl?: string;
  packaged: boolean;
  smoke: boolean;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function resolveDesktopDevOrigin({
  configuredDevUrl,
  packaged,
  smoke,
}: Omit<DesktopPageOriginOptions, 'embeddedOrigin'>): string | null {
  const configured = configuredDevUrl?.trim();
  if (!configured || packaged || smoke) return null;

  const parsed = new URL(configured);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('CC_DESKTOP_DEV_URL must use HTTP or HTTPS');
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new Error('CC_DESKTOP_DEV_URL must use a loopback host');
  }
  if (parsed.username || parsed.password) {
    throw new Error('CC_DESKTOP_DEV_URL must not contain credentials');
  }
  return parsed.origin;
}

export function resolveDesktopPageOrigin(options: DesktopPageOriginOptions): string {
  return resolveDesktopDevOrigin(options) ?? options.embeddedOrigin;
}
