import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import type { Platform } from '../src/platform.js';

test('login throttle covers Express case and trailing-slash route variants', async (context) => {
  let calls = 0;
  const platform = {
    login: async () => {
      calls++;
      return {};
    },
  } as unknown as Platform;
  const server = createApp(platform).listen(0, '127.0.0.1');
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const request = (
    path: string,
    body = JSON.stringify({ subject: 'demo:student', password: 'test' }),
  ) =>
    fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  for (let i = 0; i < 10; i++) assert.equal((await request('/auth/login')).status, 200);
  assert.equal((await request('/auth/login/')).status, 429);
  assert.equal((await request('/AUTH/LOGIN')).status, 429);
  assert.equal(calls, 10);
});

test('HTTP parsing failures are bounded JSON responses without exception details', async (context) => {
  const server = createApp({} as Platform).listen(0, '127.0.0.1');
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/auth/login`;
  for (const [body, type, expected] of [
    ['{', 'application/json', 400],
    ['secret', 'text/plain', 415],
    ['"' + 'a'.repeat(75000) + '"', 'application/json', 413],
  ] as const) {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': type }, body });
    assert.equal(response.status, expected);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const json = (await response.json()) as { error: { code: string; message: string } };
    assert.equal(typeof json.error.code, 'string');
    assert.equal(JSON.stringify(json).includes('stack'), false);
  }
});
