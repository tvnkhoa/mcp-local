---
name: index-metadata-governance
description: "Ensure index runs store complete provenance metadata for auditability and reproducibility."
---

# Index Metadata Governance

## When to Use
- Change index pipeline or persistence schema.
- Add incremental/full indexing behaviors.

## Metadata Minimum
- runId
- repoId
- mode (`full|incremental`)
- status
- indexVersion
- commitSha (nullable only when truly unavailable)
- startedAt/finishedAt
- counters (files, symbols, edges, failures, elapsedMs)

## Procedure
1. Validate schema supports all required fields.
2. Ensure pipeline populates metadata deterministically.
3. Persist policy/parser versions for provenance.
4. Expose latest run metadata via health/status endpoint.
5. Document metadata contract and migration notes.

## Output Format
- Required-field coverage report
- Missing-field remediation plan