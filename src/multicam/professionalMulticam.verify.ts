import { verifyProfessionalMulticamPersistence } from './professionalMulticamPersistence.verify';
import { verifyProfessionalMulticamSwitches } from './professionalMulticamSwitch.verify';
import { verifyProfessionalMulticamSync } from './professionalMulticamSync.verify';

await verifyProfessionalMulticamSync();
verifyProfessionalMulticamSwitches();
await verifyProfessionalMulticamPersistence();

console.log('professionalMulticam.verify: ok (persistent evidence + replaceable range switches)');
