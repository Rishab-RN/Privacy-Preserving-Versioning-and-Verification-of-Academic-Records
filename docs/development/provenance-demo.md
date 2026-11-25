# Neo4j provenance demo

From the repository root, start the existing PostgreSQL and MongoDB services,
then set up the graph. Neo4j uses a separate, loopback-only Bolt port.

```powershell
npm run db:migrate
npm run graph:configure
npm run graph:up
npm run graph -- setup
```

If Neo4j is still starting, rerun setup when it accepts connections. Setup
installs uniqueness constraints and the time-window index. Restart any API
started before setup so it loads `.env.graph`.

After worker and workflow fixture setup, identify the synthetic institution and
synchronize it.

```powershell
$fixture = Get-Content .runtime/workflow-fixture.json -Raw | ConvertFrom-Json
npm run graph -- sync $fixture.institutionId
npm run graph:measure
```

Run `npm run graph -- watch $fixture.institutionId` in a separate terminal to follow
new approvals. The watcher retries from its previous cursor after an outage.
`npm run graph -- rebuild $fixture.institutionId` replaces that institution's
derived graph from a SQL snapshot in a graph transaction.

1. Sign in as a registrar and open an approved request in **Review**.
2. Choose **View version provenance** and **Load provenance**. Confirm the version,
   approval actors, request and evidence IDs in **Version ancestry**.
3. Expand supporting request IDs under approval pairs, upward corrections and
   evidence reuse.
4. With graph watch stopped, approve a synthetic correction through the standard
   independent review. The graph view shows **Graph catching up**. Run sync and
   reload to see **Caught up**.

`npm run graph:measure` compares all four workloads against SQL and records 15 warm
sequential observations, median and p95, PostgreSQL EXPLAIN ANALYZE, Cypher PROFILE,
and per-table sizes. Find the ignored output in `.runtime/provenance-measurement.json`.
These measurements describe a small local workload. SQL reads normalized facts
and Neo4j queries a materialized projection.

Measure the graph store and transaction logs separately.

```powershell
docker compose --env-file .env.graph -f infra/docker/neo4j.yaml exec -T neo4j du -ks /data/databases/neo4j /data/transactions/neo4j
```

Physical store bytes include indexes and service metadata. Transaction logs include
preallocation. The measurement report also includes logical nodes/relationships and
selected PostgreSQL relation sizes.
