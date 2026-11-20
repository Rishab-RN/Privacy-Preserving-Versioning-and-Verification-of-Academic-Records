import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

export const LOCAL_DATABASE_KEYS = [
  'POSTGRES_DB',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'MONGO_ROOT_USER',
  'MONGO_ROOT_PASSWORD',
];

export function initializeEnvironment(projectRoot) {
  const destination = join(projectRoot, '.env');
  try {
    const existing = lstatSync(destination);
    if (!existing.isFile()) {
      throw new Error('.env exists but is not a regular file; no changes were made');
    }
    return { created: false, destination };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const template = readFileSync(join(projectRoot, '.env.example'), 'utf8');
  const parsed = parseEnv(template);
  for (const key of LOCAL_DATABASE_KEYS) {
    if (!parsed[key]?.trim()) throw new Error(`The environment template must define ${key}`);
  }

  let contents = template;
  for (const key of ['POSTGRES_PASSWORD', 'MONGO_ROOT_PASSWORD']) {
    const declaration = new RegExp(`^${key}=.*$`, 'gm');
    if ([...contents.matchAll(declaration)].length !== 1) {
      throw new Error(`The environment template must contain exactly one ${key} declaration`);
    }
    contents = contents.replace(declaration, `${key}=${randomBytes(24).toString('hex')}`);
  }

  try {
    writeFileSync(destination, contents, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    // A concurrent initializer may have created the file after the initial check.
    if (error.code === 'EEXIST') return { created: false, destination };
    throw error;
  }
  return { created: true, destination };
}

export function validateLocalEnvironment(contents) {
  const env = parseEnv(contents);
  const missing = LOCAL_DATABASE_KEYS.filter((key) => !env[key]?.trim());
  if (missing.length) return { ok: false, message: `Missing configuration: ${missing.join(', ')}` };
  for (const key of ['POSTGRES_PASSWORD', 'MONGO_ROOT_PASSWORD']) {
    if (env[key].startsWith('replace-with-')) {
      return {
        ok: false,
        message: `Replace the example value for ${key} before database initialization`,
      };
    }
  }
  const ports = [
    ['API_PORT', env.API_PORT ?? '4000'],
    ['POSTGRES_PORT', env.POSTGRES_PORT ?? '55432'],
    ['MONGO_PORT', env.MONGO_PORT ?? '57017'],
  ];
  for (const [key, value] of ports) {
    if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65535) {
      return { ok: false, message: `${key} must be an integer from 1 to 65535` };
    }
  }
  if (new Set(ports.map(([, value]) => Number(value))).size !== ports.length) {
    return { ok: false, message: 'API, PostgreSQL and MongoDB must use distinct local ports' };
  }
  return { ok: true, message: 'Local configuration present; secret values are not displayed' };
}
