import { resetServerExportRecoveryMemory } from './serverExportRecovery';
import { runServerExportLifecycleVerifications } from './serverExportOperation.lifecycle.verify-support';
import { runServerExportRecoveryVerifications } from './serverExportOperation.recovery.verify-support';

const originalFetch = globalThis.fetch;
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

try {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { href: 'http://localhost:5199/' } },
  });
  await runServerExportLifecycleVerifications();
  await runServerExportRecoveryVerifications();
  console.log('server export operation verification passed');
} finally {
  resetServerExportRecoveryMemory();
  globalThis.fetch = originalFetch;
  if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
  else Reflect.deleteProperty(globalThis, 'window');
}
