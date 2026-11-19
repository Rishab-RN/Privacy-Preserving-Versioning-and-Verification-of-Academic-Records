# Background worker

Reserved for durable publication, proof jobs and rebuildable projections. No worker
process exists yet. Future handlers must consume committed jobs idempotently and
record progress without becoming a second authority for academic data.
