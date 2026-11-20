import console from 'node:console';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { initializeEnvironment } from './lib/environment.mjs';

try {
  if (process.argv.length > 2) throw new Error('Setup accepts no flags and never overwrites .env');
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  const result = initializeEnvironment(projectRoot);
  console.info(
    result.created
      ? 'Created .env with generated local database passwords. Secret values are not displayed.'
      : 'Existing .env preserved. No configuration or database credentials were changed.',
  );
  console.info('Next: npm run doctor. Start optional databases with npm run infra:up.');
} catch (error) {
  console.error(`Setup failed: ${error.message}`);
  process.exitCode = 1;
}
