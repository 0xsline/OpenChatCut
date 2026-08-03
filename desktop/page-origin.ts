interface DesktopPageOriginOptions {
  embeddedOrigin: string;
  configuredDevUrl?: string;
  packaged: boolean;
  smoke: boolean;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export type DesktopPageUrlDecision =
  | { action: 'allow' }
  | { action: 'open-external'; url: string }
  | { action: 'deny' };

export type DesktopPageUrlSurface = 'navigation' | 'redirect' | 'popup' | 'ipc';

export function resolveDesktopPageUrlDecision(
  requestedUrl: string,
  trustedOrigin: string,
  surface: DesktopPageUrlSurface,
): DesktopPageUrlDecision {
  try {
    const requested = new URL(requestedUrl);
    const trusted = new URL(trustedOrigin);
    const usesHttp = requested.protocol === 'http:' || requested.protocol === 'https:';
    const hasCredentials = Boolean(requested.username || requested.password);

    if (usesHttp && !hasCredentials && requested.origin === trusted.origin) {
      return surface === 'popup' ? { action: 'deny' } : { action: 'allow' };
    }
    if (surface !== 'ipc' && usesHttp && !hasCredentials) {
      return { action: 'open-external', url: requested.href };
    }
  } catch {
    // Malformed URLs are never allowed into the privileged renderer or the OS.
  }
  return { action: 'deny' };
}

export function assertTrustedDesktopSenderUrl(senderUrl: string, trustedOrigin: string): void {
  if (resolveDesktopPageUrlDecision(senderUrl, trustedOrigin, 'ipc').action !== 'allow') {
    throw new Error('untrusted desktop IPC sender');
  }
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
