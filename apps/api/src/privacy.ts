import type { Router } from 'express';
import { z } from 'zod';
import type { Platform } from './platform.js';
import { parse, uuid } from './inputs.js';
import { ApiFailure } from './errors.js';
import { PrivacyService } from './privacy-runtime.js';
import { workflowFailure } from './workflow.js';
import { SCALAR_FIELD } from '@academic-records/zk';
import { loadHistoryKey, verifyCredentialHistory } from './privacy-history.js';
const scalar = z.string().regex(/^(0|[1-9][0-9]{0,76})$/);
const holderScalar = scalar.refine(
  (value) => /^(0|[1-9][0-9]{0,76})$/.test(value) && BigInt(value) < SCALAR_FIELD,
);
const point = z.array(scalar).length(3);
const proof = z
  .object({
    pi_a: point,
    pi_b: z.array(z.array(scalar).length(2)).length(3),
    pi_c: point,
    protocol: z.literal('groth16'),
    curve: z.literal('bn128'),
  })
  .strict();
export function installPrivacyRoutes(router: Router, platform: Platform) {
  let service: PrivacyService | undefined;
  const get = () => {
    if (process.env.ZK_ENABLED !== 'true')
      throw new ApiFailure(
        503,
        'ZK_NOT_CONFIGURED',
        'Zero-knowledge proof setup is not configured',
      );
    service ??= new PrivacyService(platform.repository.sql);
    return service;
  };
  router.get('/zk/config', (_req, res) => res.json(get().config()));
  router.get('/zk/artifacts/:name', (req, res) => {
    const service = get(),
      names: Record<string, string> = {
        wasm: 'grade_threshold_js/grade_threshold.wasm',
        zkey: 'grade_final.zkey',
      };
    const file = names[req.params.name as string];
    if (!file) throw new ApiFailure(404, 'NOT_FOUND', 'Artifact not found');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.sendFile(file, { root: service.directory });
  });
  router.post('/zk/records/:id/credentials', async (req, res) => {
    const { digest } = await platform.authenticate(req.get('authorization'));
    const input = parse(z.object({ credentialId: uuid, holder: holderScalar }).strict(), req.body);
    try {
      res
        .status(201)
        .json(
          await get().issue(digest, parse(uuid, req.params.id), input.credentialId, input.holder),
        );
    } catch (e) {
      workflowFailure(e);
    }
  });
  router.get('/zk/credentials/:id', async (req, res) => {
    const { digest } = await platform.authenticate(req.get('authorization'));
    try {
      const value = await get().call('read_owned', [digest, parse(uuid, req.params.id)]);
      if (!value) throw new ApiFailure(404, 'NOT_FOUND', 'Credential not found');
      res.json(value);
    } catch (e) {
      workflowFailure(e);
    }
  });
  router.post('/zk/credentials/:id/challenges', async (req, res) => {
    const { digest } = await platform.authenticate(req.get('authorization'));
    const input = parse(
      z.object({ threshold: z.number().int().min(0).max(9999) }).strict(),
      req.body,
    );
    try {
      const q = await get().call<{ challengeId: string }>('new_challenge', [
        digest,
        parse(uuid, req.params.id),
        input.threshold,
      ]);
      res.status(201).json(await get().challenge(q.challengeId));
    } catch (e) {
      workflowFailure(e);
    }
  });
  router.get('/zk/challenges/:id', async (req, res) => {
    try {
      res.json(await get().challenge(parse(uuid, req.params.id)));
    } catch (e) {
      workflowFailure(e);
    }
  });
  router.post('/zk/verify-history', async (req, res) => {
    const { artifact, history } = parse(
      z.object({ artifact: z.string().min(100).max(12000), history: z.unknown() }).strict(),
      req.body,
    );
    res.json(await verifyCredentialHistory(get(), artifact, history, loadHistoryKey()));
  });
  router.post('/zk/verify', async (req, res) => {
    const input = parse(
      z.object({ challengeId: uuid, proof, publicSignals: z.array(scalar).length(7) }).strict(),
      req.body,
    );
    try {
      res.json(
        await get().verify(input.challengeId, {
          proof: input.proof,
          publicSignals: input.publicSignals,
        }),
      );
    } catch (e) {
      if (e && typeof e === 'object' && (e as { code?: unknown }).code === '23505')
        throw new ApiFailure(409, 'CHALLENGE_USED', 'This challenge has already been consumed');
      workflowFailure(e);
    }
  });
  router.post('/zk/credentials/:id/revoke', async (req, res) => {
    const { digest } = await platform.authenticate(req.get('authorization'));
    const input = parse(z.object({ reason: z.string().trim().min(1).max(500) }).strict(), req.body);
    try {
      await get().call('revoke', [digest, parse(uuid, req.params.id), input.reason]);
      res.json({ status: 'revoked' });
    } catch (e) {
      workflowFailure(e);
    }
  });
}
