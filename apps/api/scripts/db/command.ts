import type { Client } from 'pg';
import { configuredDatabase, createDatabaseClient, safeDatabaseError } from './config.js';

export async function runDatabaseCommand(operation: (client: Client) => Promise<void>) {
  let client: Client | undefined;
  try {
    client = createDatabaseClient(configuredDatabase());
    await client.connect();
    await operation(client);
  } catch (error) {
    console.error(safeDatabaseError(error));
    process.exitCode = 1;
  } finally {
    await client?.end().catch(() => {
      process.exitCode = 1;
    });
  }
}
