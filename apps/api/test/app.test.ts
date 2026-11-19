import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { createApp } from '../src/app.js';

test('HTTP liveness and unknown-route contracts', async (context) => {
  const server = createApp().listen(0, '127.0.0.1');
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  await context.test('reports process liveness without claiming database readiness', async () => {
    const response = await fetch(`${baseUrl}/health/live`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-powered-by'), null);
    assert.deepEqual(await response.json(), { status: 'ok', service: 'scholarproof-api' });
  });

  await context.test('does not silently serve an unimplemented domain endpoint', async () => {
    const response = await fetch(`${baseUrl}/records`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
  });
});
