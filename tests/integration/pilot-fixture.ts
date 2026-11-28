import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { TestContext } from 'node:test';
import type { Client } from 'pg';
import type { PilotBatchInput } from '@scholarproof/contracts';
import { RVCE_2022_ITL_S1 } from '../../packages/assessment/src/index.js';
import { generatePilotData } from '../../packages/pilot-data/src/index.js';
import type { PilotData } from '../../packages/pilot-data/src/index.js';
import { pilotId, pilotSubjects, provisionPilot } from '../../apps/api/scripts/pilot/provision.js';
import type { CredentialTools, PilotFixture } from '../../apps/api/scripts/pilot/provision.js';
import { createApp } from '../../apps/api/src/app.js';
import { openDataRuntime, readDataConfig } from '../../apps/api/src/data-runtime.js';
import { digestToken, newToken } from '../../apps/api/src/security.js';

// Deterministic stand-in for scrypt so tests stay fast; the CLI uses the real profile.
const fakeKey = (password: string) => createHash('sha512').update(password).digest('hex');
export const testCredentials: CredentialTools = {
  hash: async (password) => ({
    profile: 'scrypt-v1',
    salt_hex: '0'.repeat(32),
    derived_key_hex: fakeKey(password),
  }),
  verify: async (password, material) => material.derived_key_hex === fakeKey(password),
};

/** Stable synthetic passwords, so every test sharing a database provisions identically. */
export function testAccounts(data: PilotData) {
  return pilotSubjects(data).map((subject, index) => ({
    subject,
    password: `pilot-test-password-${String(index).padStart(12, '0')}`,
  }));
}

export async function provisionTestPilot(
  admin: Client,
  data: PilotData = generatePilotData(),
): Promise<PilotFixture> {
  return provisionPilot(admin, testAccounts(data), testCredentials, data);
}

/** Opens a session for a login subject and returns its bearer token. */
export async function sessionFor(admin: Client, subject: string): Promise<string> {
  const token = newToken();
  const inserted = await admin.query(
    'INSERT INTO access_control.api_session(user_id,token_digest) SELECT user_id,$2 FROM academic.app_user WHERE auth_subject=$1',
    [subject, digestToken(token)],
  );
  if (inserted.rowCount !== 1) throw new Error(`No pilot account ${subject}`);
  return token;
}

export type Stage = 'cie' | 'see';

/** Required components of a stage in the pilot policy, in policy order. */
export function stageComponents(stage: Stage): string[] {
  return RVCE_2022_ITL_S1.groups
    .filter((group) => group.part === stage)
    .flatMap((group) => group.components.filter((c) => !c.optional).map((c) => c.code));
}

/** A revision built from the synthetic dataset; SEE covers only students with SEE marks. */
export function stageBody(
  data: PilotData,
  offering: string,
  stage: Stage,
  expectedRevision: number,
): PilotBatchInput {
  const codes = stageComponents(stage);
  const rows = data.assessments
    .filter((a) => a.offering === offering && codes.every((code) => code in a.marks))
    .map((a) => ({
      enrolmentId: pilotId(`enrolment:${a.usn}`),
      values: codes.map((code) => a.marks[code]!),
    }));
  return { stage, expectedRevision, components: codes, rows };
}

/** Pilot persona keys (staff and the three student personas) mapped to login subjects. */
export function personaSubjects(data: PilotData): Map<string, string> {
  const subjects = new Map(data.staff.map((member) => [member.key, member.subject]));
  for (const student of data.students) {
    if (student.persona) subjects.set(student.persona, student.subject);
  }
  return subjects;
}

export type Reply<T> = T & { error?: { code: string; message: string } };
export type PilotCall = <T>(
  method: 'GET' | 'POST',
  path: string,
  as: string | null,
  payload?: unknown,
  key?: string | null,
) => Promise<{ status: number; json: Reply<T>; code: string | undefined }>;

/**
 * Starts the real API on the restricted runtime identity. Each app instance limits a source
 * address to 100 requests a minute, so calls rotate to a fresh instance before that limit.
 */
export async function startPilotApi(t: TestContext, tokens: ReadonlyMap<string, string>) {
  const config = readDataConfig();
  assert.ok(config);
  const runtime = await openDataRuntime(config);
  t.after(() => runtime.close());
  const servers: Server[] = [];
  t.after(() => {
    for (const server of servers) {
      server.closeAllConnections();
      server.close();
    }
  });
  let port = 0;
  let used = Number.POSITIVE_INFINITY;
  async function baseUrl() {
    if (used >= 90) {
      const server = createApp(runtime.platform).listen(0, '127.0.0.1');
      servers.push(server);
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      port = address.port;
      used = 0;
    }
    used += 1;
    return `http://127.0.0.1:${port}/api/v1`;
  }
  const call: PilotCall = async <T>(
    method: 'GET' | 'POST',
    path: string,
    as: string | null,
    payload?: unknown,
    key: string | null = randomUUID(),
  ) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (as) {
      const token = tokens.get(as);
      assert.ok(token, `no session for ${as}`);
      headers.authorization = `Bearer ${token}`;
    }
    if (key && method === 'POST' && payload !== undefined) headers['idempotency-key'] = key;
    const response = await fetch(`${await baseUrl()}${path}`, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const json = (await response.json()) as Reply<T>;
    return { status: response.status, json, code: json.error?.code };
  };
  return { runtime, call };
}
