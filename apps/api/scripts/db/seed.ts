import { runDatabaseCommand } from './command.js';
import { seedDemo } from './seeds.js';

await runDatabaseCommand(async (client) => {
  console.info(
    (await seedDemo(client))
      ? 'Loaded synthetic fixture: 25 students, 4 offerings, 100 records and 2 corrections'
      : 'Synthetic fixture already applied; no existing data changed',
  );
});
