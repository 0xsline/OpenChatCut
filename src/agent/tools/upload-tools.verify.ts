import { installUploadVerifierFixture } from './upload-tools.verify-fixture';
import { verifyUploadImportSession } from './upload-tools.verify-import';
import { verifyUploadMediaFailures } from './upload-tools.verify-media';
import { verifyUploadFinalizeRecovery } from './upload-tools.verify-recovery';

const fixture = installUploadVerifierFixture();

await verifyUploadImportSession(fixture);
await verifyUploadFinalizeRecovery(fixture);
await verifyUploadMediaFailures(fixture);

fixture.restore();

console.log('upload import session verify: ok');
