import { buildPoseidon } from 'circomlibjs';
import { field } from './fields.js';
export * from './fields.js';
export * from './proof.js';
let poseidon: ReturnType<typeof buildPoseidon> | undefined;
export async function hashFields(values: readonly string[]): Promise<string> {
  poseidon ??= buildPoseidon();
  const hash = await poseidon;
  const F = hash.F as { toObject: (v: Uint8Array) => bigint };
  return F.toObject(hash(values.map((v) => BigInt(field(v))))).toString();
}
export const holderCommitment = (secret: string) => hashFields(['2026112501', secret]);
export const gradeCommitment = (
  grade: string,
  salt: string,
  context: string,
  holder: string,
  maximum: string,
) => hashFields(['2026112502', grade, salt, context, holder, maximum]);
