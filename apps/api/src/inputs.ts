import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiFailure } from './errors.js';

// PostgreSQL accepts all 128-bit UUID values, including deterministic fixtures
// without RFC version/variant bits. IDs are opaque; authorization is separate.
export const uuid = z
  .string()
  .regex(/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/)
  .transform((value) => value.toLowerCase());
export const loginInput = z
  .object({
    subject: z.string().regex(/^[a-z][a-z0-9:._-]{2,79}$/),
    password: z.string().min(1).max(128),
  })
  .strict();
const attribute = z.union([
  z.string().max(4000),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.string().max(500)).max(16),
]);
export const evidenceInput = z
  .object({
    schemaVersion: z.literal(1),
    category: z.enum(['supporting_note', 'revaluation_request']),
    data: z
      .record(
        z
          .string()
          .regex(/^[a-z][A-Za-z0-9_]{0,63}$/)
          .refine((key) => !['constructor', 'prototype', '__proto__'].includes(key)),
        attribute,
      )
      .refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 32),
  })
  .strict();
export type EvidenceInput = z.infer<typeof evidenceInput>;
const timestamp = z.iso.datetime({ offset: true }).refine((value) => !/\.\d{7,}/.test(value));
export const transcriptInput = z
  .object({
    knownAt: timestamp.optional(),
    effectiveAt: timestamp.optional(),
  })
  .strict();

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new ApiFailure(400, 'INVALID_INPUT', 'Request does not match the API contract');
  return result.data;
}

export function encodeEvidence(body: EvidenceInput) {
  const sorted = Object.fromEntries(
    Object.keys(body.data)
      .sort()
      .map((key) => [key, body.data[key]]),
  );
  const bodyUtf8 = JSON.stringify({ schemaVersion: 1, category: body.category, data: sorted });
  const sizeBytes = Buffer.byteLength(bodyUtf8, 'utf8');
  if (sizeBytes > 65536)
    throw new ApiFailure(413, 'PAYLOAD_TOO_LARGE', 'Evidence is limited to 65536 UTF-8 bytes');
  return {
    bodyUtf8,
    sizeBytes,
    digestSha256: createHash('sha256').update(bodyUtf8, 'utf8').digest('hex'),
  };
}
