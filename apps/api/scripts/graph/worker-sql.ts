import { Client } from 'pg';

export async function openWorkerSql() {
  const {
    WORKER_POSTGRES_USER: user,
    WORKER_POSTGRES_PASSWORD: password,
    POSTGRES_DB: database,
  } = process.env;
  if (
    !user ||
    !password ||
    !database ||
    user === process.env.POSTGRES_USER ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(database) ||
    ['postgres', 'template0', 'template1'].includes(database)
  )
    throw new Error('Configure the restricted SQL worker first');
  const sql = new Client({
    host: '127.0.0.1',
    port: Number(process.env.POSTGRES_PORT ?? 55432),
    database,
    user,
    password,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
  });
  try {
    await sql.connect();
    const grants = await sql.query<{ safe: boolean }>(
      `SELECT pg_has_role(current_user,'scholarproof_worker_access','USAGE')
       AND NOT has_table_privilege(current_user,'provenance.approved_fact','SELECT') AS safe`,
    );
    if (!grants.rows[0]?.safe) throw new Error('Unexpected SQL worker privileges');
    return sql;
  } catch (error) {
    await sql.end();
    throw error;
  }
}
