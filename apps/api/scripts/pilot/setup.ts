import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDatabaseCommand } from '../db/command.js';
import { projectRoot } from '../db/config.js';
import { MigrationError } from '../db/migrations.js';
import { hashPassword, verifyPassword } from '../../src/security.js';
import { pilotSubjects, provisionPilot } from './provision.js';
import type { PilotAccount } from './provision.js';

/** Creates a file once; an existing file is kept as-is. */
function createOnce(path: string, contents: string) {
  try {
    writeFileSync(path, contents, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!error || typeof error !== 'object' || (error as { code?: string }).code !== 'EEXIST') {
      throw error;
    }
  }
  if (!lstatSync(path).isFile()) throw new MigrationError(`${path} must be a regular file`);
}

const directory = join(projectRoot, '.runtime');
mkdirSync(directory, { recursive: true });
const accountsPath = join(directory, 'pilot-accounts.json');
const subjects = pilotSubjects();
createOnce(
  accountsPath,
  JSON.stringify(
    subjects.map((subject) => ({ subject, password: randomBytes(24).toString('base64url') })),
    null,
    2,
  ) + '\n',
);
const accounts = JSON.parse(readFileSync(accountsPath, 'utf8')) as PilotAccount[];
if (
  !Array.isArray(accounts) ||
  accounts.length !== subjects.length ||
  accounts.some(
    (account, index) =>
      account.subject !== subjects[index] || !/^[A-Za-z0-9_-]{32}$/.test(account.password),
  )
) {
  throw new MigrationError('Incompatible .runtime/pilot-accounts.json; no password was reset');
}

await runDatabaseCommand(async (client) => {
  const ready = await client.query<{ ready: boolean }>(
    "SELECT to_regclass('pilot.roster_delegation') IS NOT NULL AS ready",
  );
  if (!ready.rows[0]?.ready) throw new MigrationError('Apply migration 0016 before pilot:setup');
  console.info(`Provisioning the synthetic pilot institution (${accounts.length} accounts)…`);
  const fixture = await provisionPilot(client, accounts, {
    hash: hashPassword,
    verify: verifyPassword,
  });
  const fixturePath = join(directory, 'pilot-fixture.json');
  const publicFixture = JSON.stringify(
    { institutionId: fixture.institutionId, termId: fixture.termId, offerings: fixture.offerings },
    null,
    2,
  );
  createOnce(fixturePath, publicFixture + '\n');
  if (readFileSync(fixturePath, 'utf8').trim() !== publicFixture) {
    throw new MigrationError('pilot-fixture.json conflicts; the existing file was preserved');
  }
  console.info(JSON.stringify(fixture.counts));
  console.info(
    'Synthetic pilot accounts are ready. Subjects and passwords are in ignored .runtime/pilot-accounts.json',
  );
  console.info('Existing accounts, credentials and catalogue facts were not reset');
});
