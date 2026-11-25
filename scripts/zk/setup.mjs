import process from 'node:process';
import console from 'node:console';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { compiler } from './compiler.mjs';

const root = process.cwd(),
  dir = resolve(root, '.runtime/zk-v1');
mkdirSync(dir, { recursive: true });
const source = resolve('packages/zk/circuits/grade_threshold.circom');
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const manifestPath = join(dir, 'manifest.json');
if (existsSync(manifestPath)) {
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (
    m.profile !== 'academic-grade-threshold-v1' ||
    m.setup !== 'local-development-only' ||
    Object.keys(m.files).sort().join(',') !==
      [
        'grade_threshold.r1cs',
        'grade_threshold_js/grade_threshold.wasm',
        'grade_final.zkey',
        'verification_key.json',
      ]
        .sort()
        .join(',') ||
    m.sourceHash !== sha(source) ||
    Object.entries(m.files).some(([name, hash]) => sha(join(dir, name)) !== hash)
  )
    throw new Error('Existing circuit artifacts differ; no keys were replaced');
  console.log('Preserved verified local ZK artifacts.');
  process.exit(0);
}
if (existsSync(join(dir, 'grade_final.zkey')))
  throw new Error('Incomplete setup requires review; refusing key replacement');
async function run(name, args, executable = process.execPath) {
  console.log('ZK setup: ' + name);
  const child = spawn(executable, args, {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let details = '';
  child.stdout.on('data', (b) => {
    details = (details + b).slice(-4000);
  });
  child.stderr.on('data', (b) => {
    details = (details + b).slice(-4000);
  });
  const code = await new Promise((yes, no) => {
    child.on('error', no);
    child.on('exit', yes);
  });
  if (code !== 0)
    throw new Error(name + ' failed: ' + details.replace(/[a-f0-9]{64,}/gi, '[hash/entropy]'));
}
const cli = resolve('node_modules/snarkjs/build/cli.cjs');
const task = (name, args) =>
  run(name, [cli, ...args.map((v) => (v.startsWith('FILE:') ? join(dir, v.slice(5)) : v))]);
await run(
  'compile bounded circuit',
  [source, '--r1cs', '--wasm', '--sym', '--O2', '-l', resolve('node_modules'), '-o', dir],
  await compiler(),
);
await task('create local development ceremony', [
  'powersoftau',
  'new',
  'bn128',
  '12',
  'FILE:initial.ptau',
]);
await task('contribute phase one', [
  'powersoftau',
  'contribute',
  'FILE:initial.ptau',
  'FILE:contributed.ptau',
  '--name=local-development',
  '-e=' + randomBytes(64).toString('hex'),
]);
await task('verify phase one', ['powersoftau', 'verify', 'FILE:contributed.ptau']);
await task('prepare phase two', [
  'powersoftau',
  'prepare',
  'phase2',
  'FILE:contributed.ptau',
  'FILE:final.ptau',
]);
await task('derive circuit key', [
  'groth16',
  'setup',
  'FILE:grade_threshold.r1cs',
  'FILE:final.ptau',
  'FILE:grade_initial.zkey',
]);
await task('contribute circuit key', [
  'zkey',
  'contribute',
  'FILE:grade_initial.zkey',
  'FILE:grade_final.zkey',
  '--name=local-development',
  '-e=' + randomBytes(64).toString('hex'),
]);
await task('verify contributed circuit key', [
  'zkey',
  'verify',
  'FILE:grade_threshold.r1cs',
  'FILE:final.ptau',
  'FILE:grade_final.zkey',
]);
await task('export public verification key', [
  'zkey',
  'export',
  'verificationkey',
  'FILE:grade_final.zkey',
  'FILE:verification_key.json',
]);
const files = [
  'grade_threshold.r1cs',
  'grade_threshold_js/grade_threshold.wasm',
  'grade_final.zkey',
  'verification_key.json',
];
writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      profile: 'academic-grade-threshold-v1',
      setup: 'local-development-only',
      sourceHash: sha(source),
      files: Object.fromEntries(files.map((p) => [p, sha(join(dir, p))])),
    },
    null,
    2,
  ),
  { flag: 'wx' },
);
console.log(
  'Local proof artifacts verified and pinned. This single-operator development setup is not an independently contributed production ceremony.',
);
