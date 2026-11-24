export function logConfig(env: NodeJS.ProcessEnv = process.env) {
  const required = (key: string) => {
    const value = env[key];
    if (!value || value.startsWith('replace-with-')) throw new Error('Run log:setup first');
    return value;
  };
  const port = (key: string, fallback: string) => {
    const raw = env[key] ?? fallback;
    if (!/^[1-9]\d{0,4}$/.test(raw) || Number(raw) > 65535)
      throw new Error('Invalid local log service port');
    return Number(raw);
  };
  const database = required('POSTGRES_DB');
  const mongoDatabase = required('LOG_MONGO_DB');
  const user = required('LOG_POSTGRES_USER');
  const mongoUser = required('LOG_MONGO_USER');
  if (
    !/^[a-z][a-z0-9_]{0,62}$/.test(database) ||
    ['postgres', 'template0', 'template1'].includes(database) ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(mongoDatabase) ||
    ['admin', 'local', 'config'].includes(mongoDatabase) ||
    user !== 'academic_log_local' ||
    mongoUser !== 'academic_log_local'
  )
    throw new Error('Use dedicated restricted log identities and project databases');
  return {
    database,
    mongoDatabase,
    user,
    mongoUser,
    password: required('LOG_POSTGRES_PASSWORD'),
    mongoPassword: required('LOG_MONGO_PASSWORD'),
    port: port('POSTGRES_PORT', '55432'),
    mongoPort: port('MONGO_PORT', '57017'),
  };
}
