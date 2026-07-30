// 打包版把 cwd 钉到 userData:keystore 的 .env.local 路径与默认上传目录都锚在
// process.cwd()(模块顶层求值),一次 chdir 让两者自然落进用户可写区,server 侧
// 零改造。必须先于 embedded-server 的 import 链求值——main.ts 里保持本模块是
// 第一个 import(ESM 按声明序深度优先执行)。dev(未打包)沿用启动 cwd(worktree 根)。
import { mkdirSync } from 'node:fs';
import { app } from 'electron';

if (app.isPackaged) {
  const dir = app.getPath('userData');
  mkdirSync(dir, { recursive: true });
  process.chdir(dir);
}
