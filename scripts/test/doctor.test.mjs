import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectDoctorChecks } from '../lib/doctor.mjs';
import { initializeEnvironment } from '../lib/environment.mjs';
import { ENV_TEMPLATE, temporaryProject } from './helpers.mjs';

function readyProject(context) {
  const root = temporaryProject(context);
  writeFileSync(join(root, '.env.example'), ENV_TEMPLATE);
  writeFileSync(join(root, 'package-lock.json'), '{}');
  mkdirSync(join(root, 'node_modules'));
  initializeEnvironment(root);
  return root;
}

const versions = {
  npm: '11.6.2',
  git: 'git version 2.51.0',
  docker: 'Docker version 29.9.3',
  compose: '5.7.0',
  engine: '29.9.3',
};
const available = (name) => ({ ok: true, output: versions[name] });

test('reports unavailable Docker as optional until database work requires it', (context) => {
  const root = readyProject(context);
  const runCommand = (name) =>
    ['npm', 'git'].includes(name) ? available(name) : { ok: false, output: '' };
  const normal = collectDoctorChecks({ projectRoot: root, nodeVersion: '24.11.1', runCommand });
  assert.equal(
    normal.some((check) => check.status === 'FAIL'),
    false,
  );
  assert.equal(normal.filter((check) => check.status === 'WARN').length, 3);
  const required = collectDoctorChecks({
    projectRoot: root,
    nodeVersion: '24.11.1',
    runCommand,
    requireDocker: true,
  });
  assert.equal(required.filter((check) => check.status === 'FAIL').length, 3);
});

test('rejects unsupported runtime or package-manager majors', (context) => {
  const checks = collectDoctorChecks({
    projectRoot: readyProject(context),
    nodeVersion: '22.0.0',
    runCommand: (name) => (name === 'npm' ? { ok: true, output: '12.0.0' } : available(name)),
  });
  assert.equal(checks.find((check) => check.name === 'Node.js').status, 'FAIL');
  assert.equal(checks.find((check) => check.name === 'npm').status, 'FAIL');
});

test('missing setup is actionable and secret values never appear in reports', (context) => {
  const root = readyProject(context);
  const checks = collectDoctorChecks({
    projectRoot: root,
    nodeVersion: '24.11.1',
    runCommand: available,
  });
  assert.equal(
    checks.every((check) => check.status === 'PASS'),
    true,
  );
  assert.doesNotMatch(JSON.stringify(checks), /POSTGRES_PASSWORD=|MONGO_ROOT_PASSWORD=/);
  const missing = collectDoctorChecks({
    projectRoot: temporaryProject(context),
    nodeVersion: '24.11.1',
    runCommand: available,
  });
  assert.equal(missing.find((check) => check.name === 'Environment').status, 'FAIL');
  assert.equal(missing.find((check) => check.name === 'Dependencies').status, 'FAIL');
});
