import { createHash, randomUUID } from 'node:crypto';
import { ApiFailure, forbidden, notFound, unauthorized } from './errors.js';
import {
  EvidenceConflictError,
  type EvidenceDocument,
  type EvidenceStore,
} from './evidence-store.js';
import { encodeEvidence, evidenceInput, parse, type EvidenceInput } from './inputs.js';
import type { Principal, Repository, EvidenceReference } from './repository.js';
import { digestToken, dummyPassword, newToken, verifyPassword } from './security.js';

export class Platform {
  constructor(
    readonly repository: Repository,
    private readonly documents: EvidenceStore,
  ) {}
  async login(subject: string, password: string) {
    const credential = await this.repository.credential(subject);
    const valid = await verifyPassword(password, credential ?? dummyPassword);
    if (!valid || !credential || credential.account_state !== 'active') throw unauthorized();
    const token = newToken();
    const expiresAt = await this.repository.createSession(credential.user_id, digestToken(token));
    if (!expiresAt) throw unauthorized();
    return { token, tokenType: 'Bearer' as const, expiresAt };
  }
  async authenticate(header: string | undefined) {
    const match = header?.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
    if (!match?.[1]) throw unauthorized();
    const digest = digestToken(match[1]);
    const principal = await this.repository.principal(digest);
    if (!principal) throw unauthorized();
    return { principal, digest };
  }
  private requireRole(principal: Principal, roles: string[]) {
    if (!principal.roles.some(({ role }) => roles.includes(role))) throw forbidden();
  }
  async transcript(principal: Principal, studentId: string, knownAt: string, effectiveAt: string) {
    this.requireRole(principal, ['student', 'registrar', 'auditor']);
    const records = await this.repository.transcript(
      principal.userId,
      studentId,
      knownAt,
      effectiveAt,
    );
    if (!records) throw notFound();
    if (records.length > 500)
      throw new ApiFailure(413, 'RESULT_TOO_LARGE', 'Transcript exceeds prototype result limit');
    return { studentId, knownAt, effectiveAt, records };
  }
  private checkDocument(ref: EvidenceReference, doc: EvidenceDocument | null): EvidenceInput {
    if (!doc) throw new ApiFailure(503, 'EVIDENCE_UNAVAILABLE', 'Evidence content is unavailable');
    if (
      doc._id !== ref.evidence_id ||
      doc.institutionId !== ref.institution_id ||
      doc.recordId !== ref.record_id ||
      doc.submittedBy !== ref.submitted_by ||
      doc.schemaVersion !== ref.document_schema_version ||
      doc.digestSha256 !== ref.digest_sha256 ||
      doc.sizeBytes !== ref.size_bytes ||
      typeof doc.bodyUtf8 !== 'string' ||
      Buffer.byteLength(doc.bodyUtf8) !== ref.size_bytes ||
      createHash('sha256').update(doc.bodyUtf8, 'utf8').digest('hex') !== ref.digest_sha256
    ) {
      throw new ApiFailure(503, 'EVIDENCE_INTEGRITY_FAILURE', 'Evidence integrity check failed');
    }
    try {
      const body = parse(evidenceInput, JSON.parse(doc.bodyUtf8));
      if (body.category !== ref.category) throw new Error('Category mismatch');
      return body;
    } catch {
      throw new ApiFailure(503, 'EVIDENCE_INTEGRITY_FAILURE', 'Evidence integrity check failed');
    }
  }
  async upload(principal: Principal, recordId: string, requestKey: string, input: EvidenceInput) {
    this.requireRole(principal, ['student', 'registrar']);
    const record = await this.repository.record(principal.userId, recordId);
    if (!record) throw notFound();
    const encoded = encodeEvidence(input);
    const ref = await this.repository.reserve({
      evidence_id: randomUUID(),
      institution_id: record.institution_id,
      record_id: recordId,
      submitted_by: principal.userId,
      request_key: requestKey,
      category: input.category,
      document_schema_version: 1,
      digest_sha256: encoded.digestSha256,
      size_bytes: encoded.sizeBytes,
    });
    if (
      ref.record_id !== recordId ||
      ref.category !== input.category ||
      ref.digest_sha256 !== encoded.digestSha256 ||
      ref.size_bytes !== encoded.sizeBytes
    ) {
      throw new ApiFailure(
        409,
        'IDEMPOTENCY_CONFLICT',
        'This idempotency key was used for different evidence',
      );
    }
    const doc: EvidenceDocument = {
      _id: ref.evidence_id,
      schemaVersion: 1,
      institutionId: ref.institution_id,
      recordId,
      submittedBy: principal.userId,
      ...encoded,
    };
    try {
      await this.documents.put(doc);
      this.checkDocument(ref, await this.documents.get(ref.evidence_id));
    } catch (error) {
      if (error instanceof ApiFailure) throw error;
      if (error instanceof EvidenceConflictError)
        throw new ApiFailure(503, 'EVIDENCE_INTEGRITY_FAILURE', 'Evidence integrity check failed');
      throw new ApiFailure(
        503,
        'EVIDENCE_UNAVAILABLE',
        'Evidence could not be confirmed; retry with the same idempotency key',
      );
    }
    await this.repository.available(ref.evidence_id);
    return {
      evidenceId: ref.evidence_id,
      state: 'available' as const,
      digestSha256: ref.digest_sha256,
      sizeBytes: ref.size_bytes,
    };
  }
  async evidence(principal: Principal, evidenceId: string) {
    this.requireRole(principal, ['student', 'registrar']);
    const ref = await this.repository.evidence(principal.userId, evidenceId);
    if (!ref) throw notFound();
    if (ref.state !== 'available')
      throw new ApiFailure(503, 'EVIDENCE_PENDING', 'Evidence has not been confirmed');
    let doc: EvidenceDocument | null;
    try {
      doc = await this.documents.get(evidenceId);
    } catch {
      throw new ApiFailure(503, 'EVIDENCE_UNAVAILABLE', 'Evidence content is unavailable');
    }
    return {
      evidenceId,
      recordId: ref.record_id,
      state: ref.state,
      digestSha256: ref.digest_sha256,
      sizeBytes: ref.size_bytes,
      createdAt: ref.created_at,
      content: this.checkDocument(ref, doc),
    };
  }
}
