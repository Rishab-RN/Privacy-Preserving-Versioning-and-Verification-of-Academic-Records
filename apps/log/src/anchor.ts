import { merkleRoot, verifyCheckpoint } from '@academic-records/verification';
import type { KeyInput, SignedCheckpoint } from '@academic-records/verification';
import { journalCommitments, JournalError } from './journal.js';
import type { JournalSnapshot } from './journal.js';

export function assertRetainedPrefix(
  snapshot: JournalSnapshot,
  checkpoint: SignedCheckpoint,
  key: KeyInput,
) {
  if (!verifyCheckpoint(checkpoint, key))
    throw new JournalError('INVALID_CHECKPOINT', 'Retained signature is invalid');
  const body = checkpoint.body;
  if (body.logId !== snapshot.logId || body.bootstrapSize !== snapshot.bootstrapSize)
    throw new JournalError('WRONG_LOG', 'Retained checkpoint belongs to a different log');
  if (snapshot.treeSize < body.treeSize)
    throw new JournalError('ROLLBACK', 'Observed history is shorter than retained history');
  if (merkleRoot(journalCommitments(snapshot).slice(0, body.treeSize)) !== body.rootHash)
    throw new JournalError('CHECKPOINT_CONFLICT', 'Observed history differs from retained history');
  return {
    anchoredSize: body.treeSize,
    unanchoredEvents: snapshot.treeSize - body.treeSize,
    currentness: 'not-established' as const,
  };
}
