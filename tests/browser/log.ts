import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const exec = promisify(execFile);
export const browserWitnessDirectory = resolve('.runtime/browser-witness');

export async function runLog(command: string, args: string[]) {
  await exec(
    process.execPath,
    [
      '--env-file-if-exists=.env',
      '--env-file-if-exists=.env.log',
      '--import',
      'tsx',
      'apps/log/src/main.ts',
      command,
      ...args,
    ],
    { timeout: 25_000 },
  );
}

export async function retainBrowserCheckpoint(logId: string, incoming: string, previous: string[]) {
  await runLog('link', ['--log-id', logId, '--out', incoming, ...previous]);
  await exec(
    process.execPath,
    [
      '--import',
      'tsx',
      'apps/log/src/witness.ts',
      'observe',
      '--log-id',
      logId,
      '--public-key',
      '.runtime/log-keys/public.pem',
      '--incoming',
      incoming,
      '--state-dir',
      browserWitnessDirectory,
    ],
    { timeout: 15_000 },
  );
}
