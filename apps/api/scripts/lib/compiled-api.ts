import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { projectRoot } from '../db/config.js';

export interface SmokeApi {
  request(
    path: string,
    method: string,
    body?: unknown,
    token?: string,
    key?: string,
  ): Promise<unknown>;
}
export async function withCompiledApi(operation: (api: SmokeApi) => Promise<void>) {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a smoke port');
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const child = spawn(
    process.execPath,
    ['--env-file-if-exists=.env', '--env-file-if-exists=.env.api', 'apps/api/dist/server.js'],
    {
      cwd: projectRoot,
      env: { ...process.env, API_HOST: '127.0.0.1', API_PORT: String(port) },
      windowsHide: true,
      stdio: 'ignore',
    },
  );
  const ended = once(child, 'exit');
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (child.exitCode !== null) break;
      try {
        ready = (await fetch(base + '/health/live', { signal: AbortSignal.timeout(500) })).ok;
      } catch {
        /* still starting */
      }
      if (ready) break;
      await delay(100);
    }
    if (!ready) throw new Error('Compiled API startup failed');
    await operation({
      request: async (path, method, body, token, key) => {
        const response = await fetch(base + '/api/v1' + path, {
          method,
          signal: AbortSignal.timeout(8000),
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(key ? { 'Idempotency-Key': key } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!response.ok) throw new Error(`Compiled API request failed (HTTP ${response.status})`);
        return response.status === 204 ? null : await response.json();
      },
    });
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await ended;
    console.info('Stopped the temporary compiled API process');
  }
}
