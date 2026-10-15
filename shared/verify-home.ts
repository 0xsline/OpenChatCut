// Profile-home isolation for *.verify.ts suites.
//
// Verifications point the runtime profile at a throwaway directory before they
// import the modules under test. os.homedir() — and with it
// server/runtime-profile.ts — resolves USERPROFILE on Windows, not HOME, so a
// HOME-only redirect silently leaves every profile path on the real user
// profile: the verify reads and writes live data, and fails on state it never
// created. Redirect both variables, and restore both when the suite is done.
import { homedir } from 'node:os';
import { normalize } from 'node:path';

export function isolateVerifyHome(home: string): () => void {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // Fail loudly here if the platform ever stops honoring these variables: without
  // this check the suite would silently read and write the real profile again.
  if (normalize(homedir()) !== normalize(home)) {
    throw new Error(`verify home isolation failed: os.homedir() = ${homedir()}, expected ${home}`);
  }
  return () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  };
}
