# MongoDB evidence collection

The Week 3 document adapter stores bounded UTF-8 evidence in `evidence_documents`.
PostgreSQL owns the record association, immutable digest/reference and evidence
lifecycle. MongoDB is not an academic-grade authority. This adapter does not fetch
URLs, accept binary files, establish database connections or provision identities.

`initializeEvidenceCollection(db)` is an explicit administrative operation. It
creates the collection with `validationLevel: strict` and `validationAction: error`.
If it already exists, the initializer checks its type, exact validator and effective
validation settings. An incompatible collection is rejected; it is never silently
modified or dropped. Concurrent initializers inspect the winning collection before
accepting it. MongoDB's omitted strict/error defaults are accepted as equivalent.
`verifyEvidenceCollection(db)` performs the same check without creating anything;
the API uses it as a runtime readiness check with database-level `listCollections`
permission. The runtime adapter must not insert into an unprovisioned collection.

Every document requires a lowercase UUID `_id`, `institutionId`, `recordId` and
`submittedBy`; integer `schemaVersion` equal to 1; a lowercase 64-character
`digestSha256`; integer `sizeBytes` from 1 to 65,536; and nonempty `bodyUtf8` with a
maximum length of 65,536 characters. Extra fields are rejected. JSON Schema's
string length bound does not prove a UTF-8 byte count or digest: the API must enforce
the byte bound, compute the declared size/digest, and verify both against SQL on reads.

`MongoEvidenceStore` uses only `insertOne` and `findOne`. Retrying a put with the
same identifier and exactly the same document succeeds without replacing content.
An identifier collision with any different field raises `EvidenceConflictError`.
The runtime MongoDB identity must have only collection-level find/insert privileges;
it must not be able to update/delete evidence or alter validation. Administrative
accounts can bypass these controls and remain outside the ordinary runtime threat
boundary.

The service owns pending/available SQL transitions and retry behavior. MongoDB and
PostgreSQL do not share an atomic transaction. A staged document alone must not be
reported as accepted academic evidence. Documents and identifiers in demonstrations
must be synthetic; this stage does not introduce encryption or erasure guarantees.

Sources:

- [MongoDB schema validation](https://www.mongodb.com/docs/manual/core/schema-validation/)
- [MongoDB JSON Schema validation](https://www.mongodb.com/docs/manual/core/schema-validation/specify-json-schema/)
- [MongoDB privilege actions](https://www.mongodb.com/docs/manual/reference/privilege-actions/)
