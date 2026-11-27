# Pilot roster access

The first live campus pilot workflow is a read-only offering roster. The SQL
authorization is checked again for each request. The assessment policy and
synthetic-data packages can evolve independently of this layer.

| API                                                           | Output                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `GET /api/v1/pilot/offerings`                                 | Assigned offerings by course, department, section and term                      |
| `GET /api/v1/pilot/offerings/:offeringId/roster?after=<uuid>` | Up to 100 enrolment IDs and student codes, with an optional continuation cursor |

The API uses the existing bearer session. Migration `0016` adds a pilot
department and a link to its reviewing offerings. Course teachers and
examiners can read assigned offerings. HoDs and delegates can read offerings
in their department and term. An exam approver can read mapped offerings in
their institution. Exam staff can read the relevant department and term while
their roster delegation is active and its issuer still holds exam authority.
Callers with no roster grant receive 403. Authenticated roster readers receive
404 outside their scope. The response excludes marks, contact data and credentials.

The access-matrix package is the reference oracle for the pilot. Integration
tests compare the live API against its roster cases. Existing programme
membership and the course's Board of Studies are separate from the offering's
reviewing department. The scope model assumes local administrative provisioning
for this slice.

| Physical relation           | Candidate key and dependency                                                    |
| --------------------------- | ------------------------------------------------------------------------------- |
| `pilot.department`          | Department ID or institution and department code determine the other attributes |
| `pilot.offering_department` | Offering ID determines its reviewing department                                 |
| `pilot.offering_duty`       | Offering, user and duty are the key                                             |
| `pilot.department_duty`     | Department, term, user and duty are the key                                     |
| `pilot.roster_delegation`   | Delegation ID determines the scope, actors and half-open validity interval      |

Tenant identity is derived through the academic parents. The mapping and
department-duty triggers reject cross-institution combinations without copying
tenant identifiers into those relations. The API role can execute the two
scoped reads. A dedicated non-login role owns them, and the API has no direct
access to the pilot assignments or delegation rows.

The pilot frontend, synthetic account provisioning, assessment batch entry,
and publication are subsequent slices. Existing transcript, correction and
verification paths continue to use their current role checks.
