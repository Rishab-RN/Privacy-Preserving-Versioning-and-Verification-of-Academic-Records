import { execFileSync } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalBytes,
  compareCheckpoints,
  consistencyProof,
  parseCanonical,
  signCheckpoint,
  verifyEventProof,
} from '@academic-records/verification';
import type { EventProofBundle, SignedCheckpoint } from '@academic-records/verification';
import { assertRetainedPrefix } from './anchor.js';
import { auditJournal } from './audit.js';
import {
  exportEventProof,
  journalCommitments,
  JournalError,
  publishCheckpoint,
  readJournal,
} from './journal.js';
import {
  ensureSigningKeys,
  observationPath,
  readObservation,
  withObservationLock,
  writeObservation,
} from './local-state.js';
import { openLogRuntime } from './runtime.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const local = resolve(root, '.runtime'),
  observations = resolve(local, 'log-observations');
const emit = (value: unknown) => console.info(JSON.stringify(value, null, 2));
function options(args: string[]) {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (
      !key ||
      !['--log-id', '--event-id', '--credential-id', '--out', '--previous'].includes(key) ||
      !value ||
      value.startsWith('--') ||
      Object.hasOwn(values, key)
    )
      throw new Error('Invalid operator arguments');
    values[key] = value;
  }
  return values;
}
function outputPath(value: string) {
  const path = resolve(root, value);
  if (!path.startsWith(local + sep))
    throw new Error('Private proof exports must stay in the ignored .runtime directory');
  return path;
}
function save(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, canonicalBytes(value), { flag: 'wx', mode: 0o600 });
}
function requiredCheckpoint(path: string) {
  const checkpoint = readObservation(path);
  if (!checkpoint)
    throw new JournalError(
      'CHECKPOINT_UNAVAILABLE',
      'No externally retained checkpoint; publish an initial observation first',
    );
  return checkpoint;
}

async function run() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || !['publish', 'audit', 'export', 'demo'].includes(command))
    throw new Error('Use publish, audit, export or demo');
  const input = options(args);
  const fixture =
    command === 'demo'
      ? (JSON.parse(readFileSync(resolve(local, 'workflow-fixture.json'), 'utf8')) as {
          institutionId: string;
        })
      : undefined;
  const logId = input['--log-id'] ?? fixture?.institutionId;
  if (!logId) throw new Error('Provide --log-id with the institutional log UUID');
  const path = observationPath(observations, logId);
  const publicPath = resolve(local, 'log-keys/public.pem');
  if (!existsSync(publicPath)) throw new Error('Run log:setup first');
  const trusted = createPublicKey(readFileSync(publicPath));
  const runtime = await openLogRuntime(undefined, command === 'audit' || command === 'demo');
  try {
    const publish = async () =>
      withObservationLock(path, async () => {
        const keys = ensureSigningKeys(resolve(local, 'log-keys'));
        const checkpoint = await publishCheckpoint(
          runtime.sql,
          logId,
          keys.privateKey,
          keys.publicKey,
          readObservation(path),
        );
        writeObservation(path, checkpoint, keys.publicKey);
        return checkpoint;
      });
    if (command === 'publish') {
      const checkpoint = await publish();
      emit({ checkpoint, retainedAt: path, currentness: 'not-established' });
      return;
    }
    if (command === 'audit') {
      const snapshot = await readJournal(runtime.sql, logId);
      const retained = requiredCheckpoint(path);
      const anchor = assertRetainedPrefix(snapshot, retained, trusted);
      const report = await auditJournal(snapshot, runtime.db);
      emit({ ...report, anchor });
      process.exitCode =
        report.integrity === 'invalid' ? 1 : report.integrity === 'unavailable' ? 2 : 0;
      return;
    }
    if (command === 'export') {
      const credentialId = input['--credential-id'];
      if (
        Boolean(input['--event-id']) === Boolean(credentialId) ||
        (credentialId && input['--previous'])
      )
        throw new Error(
          'Choose --event-id or --credential-id. --previous applies to --event-id exports.',
        );
      const snapshot = await readJournal(runtime.sql, logId),
        checkpoint = requiredCheckpoint(path);
      assertRetainedPrefix(snapshot, checkpoint, trusted);
      const eventId =
        input['--event-id'] ??
        snapshot.entries.find(
          (entry) =>
            entry.sourceKind === 'credential' &&
            entry.payload.kind === 'credential.issued' &&
            entry.payload.credentialId === credentialId,
        )?.eventId;
      if (!eventId)
        throw new JournalError(
          'EVENT_NOT_COMMITTED',
          'Credential issuance was not found in this log',
        );
      const bundle = exportEventProof(snapshot, checkpoint, eventId);
      if (input['--previous']) {
        const previous = parseCanonical(
          readFileSync(outputPath(input['--previous'])),
        ) as unknown as SignedCheckpoint;
        const proof = consistencyProof(
          journalCommitments(snapshot).slice(0, checkpoint.body.treeSize),
          previous.body.treeSize,
        );
        const comparison = compareCheckpoints(previous, checkpoint, proof, trusted);
        if (!['valid', 'unchanged'].includes(comparison.code))
          throw new JournalError(
            'CHECKPOINT_CONFLICT',
            'Requested checkpoint extension is invalid',
          );
        bundle.consistencyProof = proof;
      }
      const target = outputPath(input['--out'] ?? `.runtime/log-demo/${logId}-${eventId}.json`);
      save(target, bundle);
      emit({
        privateProof: target,
        expectedEventId: eventId,
        logId,
        treeSize: checkpoint.body.treeSize,
      });
      return;
    }
    // Only synthetic operator fixtures are touched. Grade changes use the normal
    // independent-registrar HTTP workflow and restricted delivery worker.
    const before = await publish();
    const directory = resolve(local, 'log-demo', Date.now().toString());
    mkdirSync(directory, { recursive: true });
    const previousPath = resolve(directory, 'previous.json');
    save(previousPath, before);
    const npm = process.env.npm_execpath;
    if (!npm) throw new Error('Run the demonstration through npm run log:demo');
    execFileSync(process.execPath, [npm, 'run', 'workflow:smoke'], {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
    });
    const after = await publish();
    const snapshot = await readJournal(runtime.sql, logId);
    assertRetainedPrefix(snapshot, after, trusted);
    const chosen = [...snapshot.entries]
      .reverse()
      .find((e) => e.index >= before.body.treeSize && e.payload.kind === 'grade.accepted');
    if (!chosen) throw new Error('Synthetic workflow did not append an accepted event');
    const bundle: EventProofBundle = exportEventProof(snapshot, after, chosen.eventId);
    bundle.consistencyProof = consistencyProof(
      journalCommitments(snapshot).slice(0, after.body.treeSize),
      before.body.treeSize,
    );
    const bundlePath = resolve(directory, 'event-proof.json');
    save(bundlePath, bundle);
    const expected = { logId, eventId: chosen.eventId };
    if (
      !verifyEventProof(bundle, trusted, expected).valid ||
      compareCheckpoints(before, after, bundle.consistencyProof, trusted).code !== 'valid'
    )
      throw new Error('Positive proof verification failed');
    execFileSync(
      process.execPath,
      [
        resolve(root, 'packages/verification/dist/cli.js'),
        'verify',
        '--bundle',
        bundlePath,
        '--public-key',
        publicPath,
        '--log-id',
        logId,
        '--event-id',
        chosen.eventId,
        '--previous',
        previousPath,
      ],
      { cwd: root, stdio: 'inherit', windowsHide: true },
    );
    const altered = structuredClone(bundle);
    altered.entry.payload.kind = 'request.rejected';
    const badPath = structuredClone(bundle);
    badPath.inclusionProof = [...badPath.inclusionProof, '0'.repeat(64)];
    const badSignature = structuredClone(bundle);
    badSignature.checkpoint.signature = 'A'.repeat(86);
    const keys = ensureSigningKeys(resolve(local, 'log-keys'));
    const equivocation = signCheckpoint(
      { ...after.body, rootHash: '0'.repeat(64) },
      keys.privateKey,
    );
    const negative = {
      changedPayload: !verifyEventProof(altered, trusted, expected).valid,
      changedPath: !verifyEventProof(badPath, trusted, expected).valid,
      changedSignature: !verifyEventProof(badSignature, trusted, expected).valid,
      rollback: compareCheckpoints(after, before, [], trusted).code === 'rollback',
      conflictingSignedRoot:
        compareCheckpoints(after, equivocation, [], trusted).code === 'conflict',
    };
    if (!Object.values(negative).every(Boolean))
      throw new Error('A tamper case unexpectedly passed');
    const report = await auditJournal(snapshot, runtime.db);
    if (report.integrity !== 'valid' || report.projection !== 'complete')
      throw new Error('Live full audit did not pass');
    emit({
      beforeSize: before.body.treeSize,
      afterSize: after.body.treeSize,
      bootstrapSize: after.body.bootstrapSize,
      negativeCases: negative,
      audit: report.integrity,
      projection: report.projection,
      coverage: report.coverage,
      privateProof: bundlePath,
      retainedCheckpoint: path,
      currentness: 'not-established',
    });
  } finally {
    await runtime.close();
  }
}
run().catch((error: unknown) => {
  if (error instanceof JournalError) {
    const unavailable = [
      'CHECKPOINT_UNAVAILABLE',
      'RETAINED_CHECKPOINT_REQUIRED',
      'JOURNAL_LIMIT',
      'LOG_NOT_FOUND',
      'CLOCK_REGRESSION',
      'SIGNING_KEY_MISMATCH',
      'EVENT_NOT_COMMITTED',
    ].includes(error.code);
    emit({
      integrity: unavailable ? 'unavailable' : 'invalid',
      code: error.code,
      currentness: 'not-established',
    });
    process.exitCode = unavailable ? 2 : 1;
  } else {
    emit({
      integrity: 'unavailable',
      code: 'LOG_OPERATION_UNAVAILABLE',
      message:
        'Check operator arguments, local services, permissions and retained observations. No credentials or private payloads printed.',
    });
    process.exitCode = 2;
  }
});
