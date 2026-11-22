import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { projectRoot } from '../db/config.js';

// Run the compiled API against the explicitly provisioned local synthetic fixture.
const reservation = createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const address = reservation.address();
if (!address || typeof address === 'string')
  throw new Error('Could not reserve a local smoke port');
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
let stage = 'startup';
let responseStatus: number | undefined;
try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) break;
    try {
      ready = (await fetch(base + '/health/live', { signal: AbortSignal.timeout(500) })).ok;
    } catch {
      /* Startup may not have bound the port yet. */
    }
    if (ready) break;
    await delay(100);
  }
  if (!ready) throw new Error('Compiled API did not become live');
  stage = 'demo credentials';
  const accounts = JSON.parse(
    readFileSync(join(projectRoot, '.runtime/demo-accounts.json'), 'utf8'),
  ) as { subject: string; password: string }[];
  const student = accounts.find((account) => account.subject === 'demo:student');
  if (!student) throw new Error('Run access:demo before the smoke check');
  const request = async (
    path: string,
    method: string,
    body?: unknown,
    token?: string,
    key?: string,
  ) => {
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
    responseStatus = response.status;
    if (!response.ok) throw new Error('Compiled API smoke request failed');
    return response.status === 204 ? null : await response.json();
  };
  stage = 'login';
  const session = (await request('/auth/login', 'POST', {
    subject: student.subject,
    password: student.password,
  })) as { token: string };
  stage = 'principal';
  const me = (await request('/auth/me', 'GET', undefined, session.token)) as {
    students: { studentId: string }[];
  };
  const studentId = me.students[0]?.studentId;
  if (!studentId) throw new Error('Synthetic student is not linked');
  stage = 'transcript';
  const transcript = (await request(
    `/students/${studentId}/transcript`,
    'GET',
    undefined,
    session.token,
  )) as { records: { record_id: string }[] };
  const recordId = transcript.records[0]?.record_id;
  if (!recordId) throw new Error('Synthetic transcript is empty');
  stage = 'evidence upload';
  const receipt = (await request(
    `/records/${recordId}/evidence`,
    'POST',
    {
      schemaVersion: 1,
      category: 'supporting_note',
      data: { note: 'Synthetic compiled API smoke check' },
    },
    session.token,
    randomUUID(),
  )) as { evidenceId: string };
  stage = 'evidence read';
  await request(`/evidence/${receipt.evidenceId}`, 'GET', undefined, session.token);
  stage = 'logout';
  await request('/auth/logout', 'POST', {}, session.token);
  console.info(
    'Compiled API liveness, login, self transcript, evidence round trip and logout passed',
  );
} catch {
  console.error(
    `Compiled API smoke failed at ${stage}${responseStatus ? ` (HTTP ${responseStatus})` : ''}; no credentials printed`,
  );
  process.exitCode = 1;
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await ended;
  console.info('Stopped the temporary compiled API process');
}
