// src/bootGuardCli.ts — run by `npm run dev` before `tsx watch` (retire-host-dev D1). `tsx watch`
// stays alive after its child exits, so the boot guard and the DATA_DIR lock are checked here
// first: a host run, or a second `npm run dev` inside a running stack, exits instead of leaving
// a watcher behind.
import { acquireDataDirLock } from '@autologger/storage';
import { checkBootEnv } from './bootGuard';

const refusal = checkBootEnv(process.env);
if (refusal) {
  console.error(`autologger: ${refusal}`);
  process.exit(1);
}
try {
  acquireDataDirLock(process.env.DATA_DIR as string).release();
} catch (e) {
  console.error(`autologger: ${(e as Error).message}`);
  process.exit(1);
}
