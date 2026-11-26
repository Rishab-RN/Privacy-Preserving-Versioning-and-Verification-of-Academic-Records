# Anomaly review demo and evaluation

Week 9 ranks **approved corrections** for registrar and auditor follow-up. The
ranking is advisory and does not participate in an approval, signed-log check,
or academic record update. An isolated synthetic experiment trains the prototype.

## Run the demo

Start PostgreSQL, MongoDB and Neo4j using the [provenance setup](provenance-demo.md).
From the repository root, use Python 3.12 and the pinned requirements.

```powershell
python -m venv .venv
$ml = '.\.venv\Scripts\python.exe'
& $ml -m pip install -r apps/anomaly/requirements.txt
& $ml -m unittest discover -s apps/anomaly
& $ml apps/anomaly/run.py evaluate
$fixture = Get-Content .runtime/workflow-fixture.json -Raw | ConvertFrom-Json
npm run graph -- sync $fixture.institutionId
& $ml apps/anomaly/run.py publish $fixture.institutionId
```

On Linux, use `.venv/bin/python` for the interpreter. To demo from a browser:

1. Sign in as a registrar or auditor. Open **Provenance** and select **Load provenance**.
   The panel shows committed position coverage, generation time and model version.
2. Under **Anomaly review**, select a ranked correction. Explain each feature
   value and the validation cutoff. **Review this correction** fills the request
   lookup. Select **Find request**, then **View version provenance** to trace
   that revision's actors and evidence.
3. Approve a new synthetic correction through the independent workflow. Reload
   provenance to show the stale snapshot. Sync the graph, publish again and reload.
   The stale snapshot retains its metadata and hides its scores.

For the full browser check, first publish as above, then set
`$env:ANOMALY_PYTHON = (Resolve-Path $ml).Path` and run `npm run test:web`.

## Frozen features and runtime boundaries

| Feature key    | Value at each approved correction                                                      |
| -------------- | -------------------------------------------------------------------------------------- |
| `delta`        | Signed grade change in hundredths, using zero when a numeric comparison is unavailable |
| `missingDelta` | One for an unavailable numeric comparison, zero otherwise                              |
| `record30d`    | Prior approvals on the same grade record                                               |
| `course30d`    | Prior approvals across offerings of the same course                                    |
| `proposer30d`  | Prior approvals proposed by the same actor                                             |
| `pair30d`      | Prior approvals involving the same ordered proposer and approver, queried in Neo4j     |
| `evidence30d`  | Prior approvals with the same evidence digest, queried in Neo4j                        |

All prior counts use the interval from 30 days before the decision through just
before it. A counted event must also have a lower committed position. The
feature script reads one repeatable-read, bounded PostgreSQL outbox snapshot
through the existing restricted worker identity. Neo4j must cover that exact
position count before and after collection. Each graph row must bind to the
correction's SQL event time and position.

The scorer fits the same pinned Python profile on demand and atomically publishes
an institution snapshot while holding a local per-institution lock. It retains
the artifact in ignored `.runtime/anomaly/` with no session data, names, evidence
bodies or exact grades. The local operator controls this directory. The API
reads it for a scoped registrar or auditor and checks the SQL head and Neo4j
cursor/sync time before returning the top 20 and an optional selected version.
One process holds each publication lock. If it was interrupted, verify the
recorded process has exited before clearing that institution's lock file.
The prototype snapshot is bounded to 10,000 committed positions.

Explanations replace one feature at a time with its training median and report
up to three replacements that reduced the score. This is sensitivity to a
reference value. The model scores range from zero to one and are used for
ordering. They are neither probabilities nor causal findings.

## Reproducible synthetic comparison

Each of seeds 17, 29 and 43 generates 900 train, 450 validation and 650 test
corrections in order. Splits use disjoint actors, records, students and evidence
digests with a 35-day gap between cohorts. The simulator includes rare benign
grade changes and legitimately reused evidence. Evidence reuse as an injected
family appears only in test. Labels and split assignments stay in Python.
Neo4j receives only unlabeled facts under a temporary namespace. An independent
chronological replay checks both graph counts for every observation.

Rules sum normalized excesses above fixed feature thresholds. The two Isolation
Forest baselines share the seed and estimator settings. The graph model adds
only the two Neo4j counts. Training uses unlabeled training rows, including
synthetic contamination. The top 10% of validation scores sets each cutoff.
At evaluation time the fixed review budget is 65 test cases per seed. Ties use
event time then request ID. Reported PR-AUC uses average precision, a
stepwise precision-recall calculation. The seed-17 graph profile is selected in
advance for the portal. See the [Isolation Forest documentation](https://scikit-learn.org/stable/modules/generated/sklearn.ensemble.IsolationForest.html).

| Method                   | Average precision | Precision at 10% | Recall at 10% | False-positive rate at 10% |
| ------------------------ | ----------------: | ---------------: | ------------: | -------------------------: |
| Transparent rules        |     0.135 ± 0.028 |    0.169 ± 0.041 | 0.217 ± 0.048 |              0.090 ± 0.004 |
| Tabular Isolation Forest |     0.105 ± 0.013 |    0.133 ± 0.036 | 0.171 ± 0.046 |              0.094 ± 0.004 |
| Graph Isolation Forest   |     0.139 ± 0.027 |    0.195 ± 0.049 | 0.250 ± 0.059 |              0.087 ± 0.005 |

Values are means and sample standard deviations over the three seeds.

| Test family             | Rules reviewed | Tabular reviewed | Graph reviewed |
| ----------------------- | -------------: | ---------------: | -------------: |
| Held-out evidence reuse |           8/38 |             1/38 |          21/38 |
| Grade jump              |          18/36 |            21/36 |          11/36 |
| Pair concentration      |           5/36 |             3/36 |           5/36 |
| Record burst            |           2/42 |             1/42 |           1/42 |
| Unusual benign activity |          47/88 |            54/88 |          48/88 |

The graph model ranked more held-out evidence reuse cases but caught fewer grade
jumps than the tabular baseline. All methods performed poorly on record bursts
and often ranked unusual benign activity. The graph validation cutoff flagged
94–99 of 650 test corrections, exceeding the 65-case fixed review budget.
The rule cutoff was zero and tied with the no-rule score, so applying an
inclusive cutoff to rules marked all cases. The fixed-budget comparison remains
meaningful for that baseline. The synthetic results justify targeted follow-up
experiments and cannot estimate a real university's fraud detection rate.
Full seed-level counts, thresholds, versions and settings are in the reproducible
`.runtime/anomaly/evaluation.json` output.
