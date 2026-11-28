import { createHash } from 'node:crypto';
import type { Client } from 'pg';
import { generatePilotData } from '../../packages/pilot-data/src/index.js';
import type { PilotData } from '../../packages/pilot-data/src/index.js';
import { pilotSubjects, provisionPilot } from '../../apps/api/scripts/pilot/provision.js';
import type { CredentialTools, PilotFixture } from '../../apps/api/scripts/pilot/provision.js';
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
