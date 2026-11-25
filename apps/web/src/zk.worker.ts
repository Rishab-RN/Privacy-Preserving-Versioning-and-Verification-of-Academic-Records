import { proveEligibility } from '@academic-records/zk/browser';
import type { PublicStatement, PrivateWitness } from '@academic-records/zk/browser';
self.onmessage = async (
  event: MessageEvent<{
    statement: PublicStatement;
    witness: PrivateWitness;
    wasmHash: string;
    provingKeyHash: string;
  }>,
) => {
  try {
    async function artifact(name: string, expected: string) {
      const response = await fetch('/api/v1/zk/artifacts/' + name, { cache: 'no-store' });
      if (!response.ok) throw new Error('Proof artifacts unavailable');
      const bytes = new Uint8Array(await response.arrayBuffer());
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
      if (hash !== expected) throw new Error('Proof artifact hash mismatch');
      return bytes;
    }
    const [wasm, zkey] = await Promise.all([
      artifact('wasm', event.data.wasmHash),
      artifact('zkey', event.data.provingKeyHash),
    ]);
    const bundle = await proveEligibility(event.data.statement, event.data.witness, { wasm, zkey });
    self.postMessage({ bundle });
  } catch {
    self.postMessage({
      error: 'Proof generation failed. Check the grade threshold, wallet and proof artifacts.',
    });
  }
};
