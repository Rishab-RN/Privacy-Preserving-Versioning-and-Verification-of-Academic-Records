# Access and evidence - Week 3

This slice adds a local identity adapter, scoped academic reads and bounded JSON
evidence. It does not issue/correct grades, approve revaluations, encrypt stored
records or publish credentials. Academic-policy and owner-diagram review remains
open; the SQL model is still provisional.

## Identity and sessions

Accounts are administratively provisioned. There is no public signup, role editor,
password-reset flow, institutional SSO or JWT issuer. `app_user.auth_subject` is a
case-sensitive local login ID. A later institutional OIDC adapter must bind issuer
and subject explicitly rather than treating an arbitrary subject as globally
trusted.

Passwords use Node's asynchronous scrypt, profile `scrypt-v1`: N=131072, r=8, p=1,
a random 16-byte salt and 64-byte derived key. Hash work is limited to two concurrent
jobs; each operation needs approximately 128 MiB. The verifier uses constant-time
key comparison and a dummy credential for unknown subjects. Login accepts at most
128 characters; provisioned passwords require at least 14. Generic authentication
failures do not identify absent or disabled accounts.

Each session uses a random 32-byte bearer token. PostgreSQL retains only its
SHA-256 digest, user, creation time, one-hour absolute expiry and one-way revocation
state. Login returns the token once. It is accepted only in `Authorization: Bearer`
and is never put in URLs or cookies. Authenticated API responses use `no-store`.
Account state and institutional roles are read again on each request; resource
queries also check live academic scope. Revocation affects subsequent requests;
an already-authorized in-flight cross-store operation is not atomically cancelled.

Login has a bounded per-process, per-source-IP limit of 10 attempts per 15 minutes,
including valid attempts; API requests have a 100/minute source-IP limit. Forwarded
IP headers are not trusted. These prototype limits are neither a distributed
rate-limit service nor a solution to campus NAT or public credential-stuffing.
Review them with proxy/TLS, account lifecycle and identity federation before real
deployment. Browser token persistence is not implemented; do not store these
tokens in localStorage. A future browser session design should choose in-memory
tokens or HttpOnly cookies with explicit CSRF protection. Use HTTPS outside the
local loopback development environment.

## Authorization policy

| Operation                    | Student                     | Registrar       | Auditor         | Examiner |
| ---------------------------- | --------------------------- | --------------- | --------------- | -------- |
| Read transcript              | Own linked student only     | Own institution | Own institution | Denied   |
| Submit/read evidence content | Own linked student's record | Own institution | Denied          | Denied   |
| Modify academic facts/roles  | Denied                      | Denied          | Denied          | Denied   |

Institutional examiner/course assignments and auditor evidence-content policy
have not been modelled, so those roles receive no implicit broader access. An
allowed role requesting a missing or inaccessible subject receives the same 404.
A role disallowed for the operation receives 403. Client-supplied user, tenant or
author fields never define the principal. Known-at queries accept ISO8601 strings
with an offset and at most six fractional digits; transcript `recorded_at` values
retain PostgreSQL microseconds in UTC ISO8601 text.

## Credentials and database privilege boundaries

Migrations use the existing administrative `.env`. Explicit `access:setup` creates
an ignored `.env.api` only when missing, then provisions separate API logins. It
preserves both environment files and existing passwords on repeated runs. A failed
cross-store setup can be partial; rerun with the preserved file after fixing the
cause. It never resets an existing password or silently repairs unexpected grants.

`scholarproof_api_access` allows academic reads, password verification, session
creation/revocation and evidence-reference insertion/state changes. It cannot
append grades, alter roles/catalogue facts, change immutable evidence metadata or
create schema objects. Migrations harden reuse of the old read-only group against
inherited memberships and effective writes. Runtime startup independently checks
its actual SQL identity and the effective Mongo privileges for drift.

Mongo API privileges permit only `find`/`insert` on `evidence_documents` and
`listCollections` for validator readiness. Provisioning creates the collection's
strict/error validator explicitly. Startup refuses missing/incompatible validation;
it never creates or changes a collection. Update, delete, validator modification
and validation bypass are unavailable to the runtime user.

These are application-layer tenant/subject checks backed by a non-owner database
role; they are not PostgreSQL RLS. A compromised API process/login can read the
prototype's accessible academic tables. Database administrators remain trusted for
this stage and can rewrite data or permissions. Cryptographic auditing and witness
retention are later mechanisms.

## Evidence profile and write protocol

Version 1 evidence is a synthetic JSON form with a category and 1-32 named data
attributes. Values may be bounded strings, finite numbers, booleans, null or short
string lists. Unknown top-level fields, unsafe keys and unsupported schema versions
are rejected. The encoded document is limited to 65536 UTF-8 bytes, and the HTTP
JSON parser is bounded separately. Arbitrary PDF/binary attachments, URL fetching,
OCR and malware scanning are not part of this profile.

The digest profile is `json-v1`: construct `{schemaVersion,category,data}` in that
order, sort the data object's keys, serialize with JavaScript `JSON.stringify`,
encode UTF-8 and hash with SHA-256. This is a pinned prototype encoding, not an
RFC 8785 interoperability claim. The exact encoded bytes are retained as
`bodyUtf8` in Mongo alongside immutable identity/digest/size metadata. Server-owned
IDs and SQL timestamps are not client form fields.

1. Authenticate and verify record/subject scope before accessing Mongo.
2. Require a UUID `Idempotency-Key`. Reserve an immutable SQL evidence reference
   in `pending`, scoped to the authenticated submitter and key.
3. Insert the Mongo document with the SQL evidence UUID as `_id`. A duplicate is
   accepted only if the complete document is exactly the same.
4. Read it back and verify SQL identity, schema, byte length and recomputed digest.
   Only then change SQL state to `available` and acknowledge success.

Repeating a key with different content or another record returns 409. The same
request after a failure can resume from its pending reference, including after a
Mongo acknowledgement or SQL finalization failure. No grade is changed by this
operation. There is no distributed SQL/Mongo transaction or background recovery
worker yet; pending work is durable and recovered by an explicit same-key retry.

Reads authorize against SQL before contacting Mongo and verify its metadata and
raw-byte digest before parsing/returning content. Missing/unavailable/pending
content returns 503. A mismatch returns `EVIDENCE_INTEGRITY_FAILURE` with no
unverified content. A SQL digest alone is not a signature or external tamper proof.
The prototype stores evidence plaintext and makes no erasure/privacy guarantee.

## References

- [OWASP password storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [OWASP session management guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [MongoDB schema validation](https://www.mongodb.com/docs/manual/core/schema-validation/)
