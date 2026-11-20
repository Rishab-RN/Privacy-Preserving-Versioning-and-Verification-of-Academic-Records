import { applyMigrations, migrationStatus } from './migrations.js';
import { runDatabaseCommand } from './command.js';

const command = process.argv[2] ?? 'up';
if (!['up', 'status'].includes(command) || process.argv.length > 3) {
  console.error(
    'Usage: db:migrate or db:status. Destructive down/reset commands are not provided.',
  );
  process.exitCode = 1;
} else {
  await runDatabaseCommand(async (client) => {
    if (command === 'up') {
      const applied = await applyMigrations(client);
      console.info(
        applied.length ? `Applied: ${applied.join(', ')}` : 'All migrations are already applied',
      );
    }
    for (const row of await migrationStatus(client))
      console.info(`${row.state.toUpperCase()} ${row.name}`);
  });
}
