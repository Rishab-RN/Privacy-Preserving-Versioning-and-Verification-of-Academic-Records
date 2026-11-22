import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from '../db/config.js';
import { runDatabaseCommand } from '../db/command.js';
import { hashPassword, verifyPassword, type PasswordMaterial } from '../../src/security.js';

interface Account {
  subject: string;
  password: string;
  role: string;
}
await runDatabaseCommand(async (client) => {
  const institution = await client.query<{ institution_id: string }>(
    "SELECT institution_id FROM academic.institution WHERE institution_code='DEMO_UNIVERSITY'",
  );
  const institutionId = institution.rows[0]?.institution_id;
  if (!institutionId) throw new Error('Run db:seed before access:demo');
  const directory = join(projectRoot, '.runtime');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'demo-accounts.json');
  const intended = [
    ['demo:registrar', 'registrar'],
    ['demo:student', 'student'],
    ['demo:auditor', 'auditor'],
  ] as const;
  try {
    writeFileSync(
      path,
      JSON.stringify(
        intended.map(([subject, role]) => ({
          subject,
          role,
          password: randomBytes(24).toString('base64url'),
        })),
        null,
        2,
      ) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
  } catch (error) {
    if (!error || typeof error !== 'object' || (error as { code?: string }).code !== 'EEXIST')
      throw error;
  }
  if (!lstatSync(path).isFile()) throw new Error('Demo account path must be a regular file');
  const accounts: Account[] = JSON.parse(readFileSync(path, 'utf8'));
  if (
    !Array.isArray(accounts) ||
    accounts.length !== intended.length ||
    accounts.some(
      (account, index) =>
        account.subject !== intended[index]![0] ||
        account.role !== intended[index]![1] ||
        !/^[A-Za-z0-9_-]{32}$/.test(account.password),
    )
  ) {
    throw new Error('Incompatible demo account configuration; no credentials were changed');
  }
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1,$2)', [1936747376, 4]);
    for (const account of accounts) {
      await client.query(
        'INSERT INTO academic.app_user(auth_subject) VALUES($1) ON CONFLICT(auth_subject) DO NOTHING',
        [account.subject],
      );
      const user = await client.query<{ user_id: string }>(
        'SELECT user_id FROM academic.app_user WHERE auth_subject=$1',
        [account.subject],
      );
      const userId = user.rows[0]!.user_id;
      await client.query(
        'INSERT INTO academic.role_assignment(institution_id,user_id,role_code) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [institutionId, userId, account.role],
      );
      const existing = await client.query<PasswordMaterial>(
        'SELECT profile,salt_hex,derived_key_hex FROM access_control.password_credential WHERE user_id=$1',
        [userId],
      );
      if (existing.rows[0]) {
        if (!(await verifyPassword(account.password, existing.rows[0])))
          throw new Error('Existing demo credential differs; no password was reset');
      } else {
        const material = await hashPassword(account.password);
        await client.query(
          'INSERT INTO access_control.password_credential(user_id,profile,salt_hex,derived_key_hex) VALUES($1,$2,$3,$4)',
          [userId, material.profile, material.salt_hex, material.derived_key_hex],
        );
      }
      if (account.role === 'student') {
        const bound = await client.query(
          "UPDATE academic.student SET user_id=$1 WHERE institution_id=$2 AND student_code='DEMO_STUDENT_001' AND (user_id IS NULL OR user_id=$1)",
          [userId, institutionId],
        );
        if (bound.rowCount !== 1)
          throw new Error('Demo student already belongs to a different account');
      }
    }
    await client.query('COMMIT');
    console.info(
      'Three synthetic demo accounts verified; credentials are in ignored .runtime/demo-accounts.json',
    );
    console.info('Existing passwords were preserved; no credentials were printed');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
});
