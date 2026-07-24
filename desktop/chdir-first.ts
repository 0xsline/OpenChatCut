// The packaged version nails cwd to the .env.local path of userData:keystore and the default upload directory is anchored in
// process.cwd() (module top-level evaluation), one chdir allows the two to naturally fall into the user-writable area, server side
// Zero modifications. Must be evaluated before the import chain of embedded-server - keep this module in main.ts
// The first import (ESM is executed depth first in declaration order). dev (unpackaged) inherits the startup cwd (worktree root).
import { mkdirSync } from 'node:fs';
import { app } from 'electron';

if (app.isPackaged) {
  const dir = app.getPath('userData');
  mkdirSync(dir, { recursive: true });
  process.chdir(dir);
}
