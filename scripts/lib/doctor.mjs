import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { validateLocalEnvironment } from './environment.mjs';

const COMMANDS = {
  npm: 'npm --version',
  git: 'git --version',
  docker: 'docker --version',
  compose: 'docker compose version --short',
  engine: 'docker info --format "{{.ServerVersion}}"',
};

export function runPrerequisiteCommand(name) {
  // Commands are a fixed allowlist. No user configuration or secrets enter a shell.
  if (!Object.hasOwn(COMMANDS, name)) throw new Error('Unknown prerequisite command');
  const result = spawnSync(COMMANDS[name], {
    shell: true,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 8000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { ok: result.status === 0 && !result.error, output: result.stdout ?? '' };
}

function versionOf(output) {
  return output.match(/\b\d+\.\d+\.\d+\b/)?.[0];
}

export function collectDoctorChecks({
  projectRoot,
  requireDocker = false,
  nodeVersion = process.versions.node,
  runCommand = runPrerequisiteCommand,
}) {
  const checks = [];
  const add = (name, ok, message, optional = false) => {
    checks.push({ name, status: ok ? 'PASS' : optional ? 'WARN' : 'FAIL', message });
  };
  add(
    'Node.js',
    Number(nodeVersion.split('.')[0]) === 24,
    `Found ${nodeVersion}; required major: 24`,
  );
  const npm = runCommand('npm');
  const npmVersion = versionOf(npm.output);
  add(
    'npm',
    npm.ok && npmVersion?.startsWith('11.'),
    `Found ${npmVersion ?? 'unavailable'}; required major: 11`,
  );
  const git = runCommand('git');
  add(
    'Git',
    git.ok,
    git.ok ? `Found ${versionOf(git.output) ?? 'installed'}` : 'Install Git and add it to PATH',
  );

  const hasLockfile = existsSync(join(projectRoot, 'package-lock.json'));
  add(
    'Lockfile',
    hasLockfile,
    hasLockfile ? 'Root package-lock.json present' : 'Root package-lock.json required',
  );
  const hasDependencies = existsSync(join(projectRoot, 'node_modules'));
  add(
    'Dependencies',
    hasDependencies,
    hasDependencies
      ? 'Directory present; npm run check verifies the installed tooling'
      : 'Run npm ci to install locked dependencies',
  );
  try {
    const envPath = join(projectRoot, '.env');
    if (!statSync(envPath).isFile()) throw new Error('invalid environment path');
    const result = validateLocalEnvironment(readFileSync(envPath, 'utf8'));
    add('Environment', result.ok, result.message);
  } catch {
    add('Environment', false, 'Run npm run setup; .env must be a readable regular file');
  }

  const docker = runCommand('docker');
  add(
    'Docker CLI',
    docker.ok,
    docker.ok
      ? `Found ${versionOf(docker.output) ?? 'installed'}`
      : 'Install Docker Desktop for database work',
    !requireDocker,
  );
  const compose = runCommand('compose');
  add(
    'Docker Compose',
    compose.ok,
    compose.ok
      ? `Found ${versionOf(compose.output) ?? 'installed'}`
      : 'Docker Compose is unavailable',
    !requireDocker,
  );
  const engine = docker.ok ? runCommand('engine') : { ok: false, output: '' };
  add(
    'Docker engine',
    engine.ok,
    engine.ok
      ? `Accessible (${versionOf(engine.output) ?? 'version unavailable'})`
      : 'Start Docker Desktop or check engine access permissions',
    !requireDocker,
  );
  return checks;
}
