---
name: magika-file-filtering
description: "Classify and filter files with Magika before indexing to improve codebase analysis quality and performance. Use for allowlist/denylist and noise reduction in index pipelines."
---

# Magika File Filtering

## When to Use
- Reduce indexing noise from binaries/generated/vendor files.
- Improve parser throughput and index quality.

## Procedure
1. Run Magika classification on candidate files.
2. Apply policy layers:
   - allowlist source-like types
   - denylist binaries/artifacts
   - path-based exclusions (`dist`, `build`, caches)
3. Emit filtering statistics per run.
4. Persist reasons for skip decisions for audit/debug.

## Guardrails
- Never trust extension only; combine classifier + path rules.
- Keep policy versioned to explain index differences over time.
- Allow controlled overrides for specific internal repos.
