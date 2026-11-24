import { poseidon2 } from 'poseidon-lite/poseidon2';
import { field } from './fields.js';
export * from './fields.js';
export * from './proof.js';
export async function holderCommitment(secret: string): Promise<string> {
  return poseidon2([2026112501n, BigInt(field(secret))]).toString();
}
