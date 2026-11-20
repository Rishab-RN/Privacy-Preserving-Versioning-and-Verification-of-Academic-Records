import console from 'node:console';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { collectDoctorChecks } from './lib/doctor.mjs';

const flags = process.argv.slice(2);
if (flags.some((flag) => flag !== '--require-docker')) {
  console.error('Usage: npm run doctor [-- --require-docker]');
  process.exitCode = 1;
} else {
  const checks = collectDoctorChecks({
    projectRoot: fileURLToPath(new URL('../', import.meta.url)),
    requireDocker: flags.includes('--require-docker'),
  });
  for (const check of checks) console.info(`${check.status} ${check.name}: ${check.message}`);
  console.info(
    'Container health and authenticated database access: npm run infra:status / infra:check.',
  );
  console.info('Compiler, tests and build: npm run check && npm run build.');
  process.exitCode = checks.some((check) => check.status === 'FAIL') ? 1 : 0;
}
