import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const ENV_TEMPLATE = [
  'NODE_ENV=development',
  'API_PORT=4000',
  'POSTGRES_DB=scholarproof',
  'POSTGRES_USER=scholarproof',
  'POSTGRES_PASSWORD=replace-with-a-local-postgres-password',
  'POSTGRES_PORT=55432',
  'MONGO_ROOT_USER=scholarproof',
  'MONGO_ROOT_PASSWORD=replace-with-a-local-mongo-password',
  'MONGO_PORT=57017',
  '',
].join('\n');

export function temporaryProject(context) {
  const parent = realpathSync(tmpdir());
  const directory = mkdtempSync(join(parent, 'academic-records-tooling-'));
  context.after(() => {
    const resolved = realpathSync(directory);
    if (
      dirname(resolved) !== parent ||
      !basename(resolved).startsWith('academic-records-tooling-')
    ) {
      throw new Error('Refusing cleanup outside the created tooling fixture');
    }
    rmSync(resolved, { recursive: true, force: true });
  });
  return directory;
}
