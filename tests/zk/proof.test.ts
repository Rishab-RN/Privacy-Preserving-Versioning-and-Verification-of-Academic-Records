import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { groth16 } from 'snarkjs';
import {
  gradeCommitment,
  holderCommitment,
  proveEligibility,
  verifyEligibility,
  SCALAR_FIELD,
} from '../../packages/zk/src/index.js';
const dir = resolve('.runtime/zk-v1');
const artifacts = {
  wasm: resolve(dir, 'grade_threshold_js/grade_threshold.wasm'),
  zkey: resolve(dir, 'grade_final.zkey'),
};
const vk: unknown = JSON.parse(readFileSync(resolve(dir, 'verification_key.json'), 'utf8'));
after(async () => {
  await (
    globalThis as { curve_bn128?: { terminate: () => Promise<void> } }
  ).curve_bn128?.terminate();
});
test('real Groth16 threshold proof binds hidden grade, holder, context and verifier challenge', async (context) => {
  const witness = {
    grade: '850',
    salt: '93847199234578347821983748213749821374',
    secret: '8819847398221837498173274811324941824',
  };
  const holder = await holderCommitment(witness.secret);
  const statement = {
    commitment: await gradeCommitment(witness.grade, witness.salt, '1234', holder, '1000'),
    context: '1234',
    holder,
    maximum: '1000',
    threshold: '800',
    challenge: '987654321',
  };
  const bundle = await proveEligibility(statement, witness, artifacts);
  assert.equal(await verifyEligibility(bundle, statement, vk), true);
  assert.equal(bundle.publicSignals.length, 7);
  assert(!bundle.publicSignals.includes(witness.grade));
  assert(!JSON.stringify(bundle).includes('"secret"'));
  await context.test(
    'changed public threshold, challenge, holder, context, maximum and commitment fail',
    async () => {
      for (const changed of [
        { threshold: '900' },
        { challenge: '987654322' },
        { holder: '1' },
        { context: '1235' },
        { maximum: '999' },
        { commitment: '1' },
      ]) {
        assert.equal(await verifyEligibility(bundle, { ...statement, ...changed }, vk), false);
        const altered = structuredClone(bundle);
        const inputs = [
          statement.commitment,
          statement.context,
          statement.holder,
          statement.maximum,
          statement.threshold,
          statement.challenge,
        ];
        const key = Object.keys(changed)[0] as keyof typeof statement;
        const index = [
          'commitment',
          'context',
          'holder',
          'maximum',
          'threshold',
          'challenge',
        ].indexOf(key);
        altered.publicSignals[index + 1] = Object.values(changed)[0]!;
        assert.equal(await verifyEligibility(altered, { ...statement, ...changed }, vk), false);
        assert.equal(inputs.length, 6);
      }
    },
  );
  await context.test('modified proof, scalar aliases and wrong verification key fail', async () => {
    const changed = structuredClone(bundle);
    changed.proof.pi_a[0] = '1';
    assert.equal(await verifyEligibility(changed, statement, vk), false);
    const alias = structuredClone(bundle);
    alias.publicSignals[1] = (BigInt(statement.commitment) + SCALAR_FIELD).toString();
    assert.equal(await verifyEligibility(alias, statement, vk), false);
    assert.equal(await verifyEligibility(bundle, statement, {}), false);
  });
  await context.test(
    'raw circuit rejects invalid witnesses independently of host pre-validation',
    async () => {
      for (const invalid of [
        { grade: '799' },
        { grade: '1001' },
        { salt: '123' },
        { secret: '123' },
      ]) {
        await assert.rejects(
          groth16.fullProve(
            { ...statement, ...witness, ...invalid },
            artifacts.wasm,
            artifacts.zkey,
            undefined,
            undefined,
            { singleThread: true },
          ),
        );
      }
    },
  );
  await context.test(
    'new challenge needs a new proof; equal-threshold boundary succeeds',
    async () => {
      const fresh = { ...statement, threshold: '850', challenge: '987654322' };
      const next = await proveEligibility(fresh, witness, artifacts);
      assert.equal(await verifyEligibility(next, fresh, vk), true);
      assert.notEqual(next.publicSignals[0], bundle.publicSignals[0]);
      assert.equal(await verifyEligibility(next, statement, vk), false);
    },
  );
});
