import type { Groth16Proof } from 'snarkjs';
export const SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export interface PublicStatement {
  commitment: string;
  context: string;
  holder: string;
  maximum: string;
  threshold: string;
  challenge: string;
}
export interface PrivateWitness {
  grade: string;
  salt: string;
  secret: string;
}
export interface EligibilityProof {
  proof: Groth16Proof;
  publicSignals: string[];
}
export function field(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]{0,76})$/.test(value) ||
    BigInt(value) >= SCALAR_FIELD
  )
    throw new Error('Invalid canonical field element');
  return value;
}
export function fixedPoints(value: string): string {
  if (!/^(0|[1-9][0-9]?)(\.[0-9]{1,2})?$/.test(value))
    throw new Error('Use grade points with at most two decimals');
  const [whole, decimal = ''] = value.split('.');
  return (BigInt(whole!) * 100n + BigInt(decimal.padEnd(2, '0'))).toString();
}
export function privateScalar(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(31));
  return bytes.reduce((n, b) => (n << 8n) + BigInt(b), 0n).toString();
}
/** Domain-separated metadata/challenge binding without silent modulo reduction. */
export async function contextField(domain: string, value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(domain + '\0' + value),
  );
  const hex = Array.from(new Uint8Array(digest).slice(0, 31), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  return BigInt('0x' + hex).toString();
}
export function publicInputs(statement: PublicStatement): string[] {
  const result = [
    statement.commitment,
    statement.context,
    statement.holder,
    statement.maximum,
    statement.threshold,
    statement.challenge,
  ].map(field);
  if (
    BigInt(statement.maximum) > 9999n ||
    BigInt(statement.maximum) < 1n ||
    BigInt(statement.threshold) > BigInt(statement.maximum)
  )
    throw new Error('Invalid grade policy');
  return result;
}
