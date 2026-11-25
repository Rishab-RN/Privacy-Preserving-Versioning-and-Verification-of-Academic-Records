import { groth16 } from 'snarkjs';
import type { ZKArtifact } from 'snarkjs';
import { publicInputs, field } from './fields.js';
import type { PublicStatement, PrivateWitness, EligibilityProof } from './fields.js';
export async function proveEligibility(
  statement: PublicStatement,
  witness: PrivateWitness,
  artifacts: { wasm: ZKArtifact; zkey: ZKArtifact },
): Promise<EligibilityProof> {
  publicInputs(statement);
  for (const v of [witness.salt, witness.secret])
    if (BigInt(field(v)) >= 1n << 248n) throw new Error('Private scalar exceeds 248 bits');
  if (
    BigInt(field(witness.grade)) > BigInt(statement.maximum) ||
    BigInt(witness.grade) < BigInt(statement.threshold)
  )
    throw new Error('Grade does not meet requested threshold');
  const result = await groth16.fullProve(
    { ...statement, ...witness },
    artifacts.wasm,
    artifacts.zkey,
    undefined,
    undefined,
    { singleThread: true },
  );
  if (result.publicSignals.slice(1).join(',') !== publicInputs(statement).join(','))
    throw new Error('Unexpected compiled public-input layout');
  return result;
}
export async function verifyEligibility(
  bundle: EligibilityProof,
  expected: PublicStatement,
  verificationKey: unknown,
): Promise<boolean> {
  try {
    const inputs = publicInputs(expected);
    if (
      !bundle ||
      !Array.isArray(bundle.publicSignals) ||
      bundle.publicSignals.length !== 7 ||
      bundle.publicSignals.slice(1).join(',') !== inputs.join(',')
    )
      return false;
    bundle.publicSignals.forEach(field);
    if (!bundle.proof || bundle.proof.protocol !== 'groth16' || bundle.proof.curve !== 'bn128')
      return false;
    if (JSON.stringify(bundle.proof).length > 4096) return false;
    return await groth16.verify(verificationKey, bundle.publicSignals, bundle.proof);
  } catch {
    return false;
  }
}
