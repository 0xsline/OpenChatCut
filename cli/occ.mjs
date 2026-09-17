#!/usr/bin/env node
// Launcher for the TypeScript CLI: `occ` resolves to this file once the package
// is linked (`npm link`), and it runs the real entry point through the repo's own
// tsx loader. Keep it dependency-free — it runs before any project code loads.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = join(dirname(fileURLToPath(import.meta.url)), 'main.ts');
const child = spawn(process.execPath, ['--import', 'tsx', entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(),
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
