# Citation patterns: `.codebase-index/citations.json`

**Status:** format v1, published 2026-10-20 ahead of release C of the wec.aria adoption plan. **Nothing
reads this file yet.** The docs lane starts reading it in release C (citation edges, R5/R6). The
format is published early so a repo can write its file before that lands.

## Why a per-repo file

Repos cite their own documents in their own shorthand: wec.aria writes `docs/15 #737`, `15 #726`,
`adr/0057`, `SPEC-022`, `09 #10`. A citation is an edge an index can answer set questions over:
"show row #737", "who cites adr/0021", "which rows cite this file". Grep cannot answer those.

The shorthand belongs to the repo, so the repo declares it, and the server holds no repo-specific
pattern. The file lives in the indexed repo at `.codebase-index/citations.json`, is written and
versioned by that repo, and is only read by the indexer.

## Format

```json
{
  "version": 1,
  "registryDoc": "docs/10-canonical-model.md",
  "scan": { "markdown": true, "codeComments": true },
  "citations": [
    {
      "id": "decision-row",
      "pattern": "(?:docs/)?15 #(\\d{1,4})",
      "target": "docs/15-decision-log.md",
      "anchor": { "kind": "tableRow", "column": 1, "value": "{1}" }
    },
    {
      "id": "doc-row",
      "pattern": "\\b(0\\d) #(\\d{1,3})\\b",
      "target": "docs/{1}-*.md",
      "anchor": { "kind": "tableRow", "column": 1, "value": "{2}" }
    },
    {
      "id": "adr",
      "pattern": "\\badr/(\\d{4})\\b",
      "target": "docs/adr/{1}-*.md",
      "anchor": { "kind": "file" }
    },
    {
      "id": "spec",
      "pattern": "\\bSPEC-(\\d{3})\\b",
      "target": "specs/SPEC-{1}*.md",
      "anchor": { "kind": "file" }
    },
    {
      "id": "invariant-held-by-test",
      "pattern": "<!--inv:by=test:([^#>]+)#([^>]*?)-->",
      "target": "{1}",
      "anchor": { "kind": "testName", "value": "{2}" }
    }
  ]
}
```

The example paths are illustrative; wec.aria writes its own.

### Fields

| Field | Required | Meaning |
|---|---|---|
| `version` | yes | Always `1`. Any other value refuses the whole file, with a `health_check` reason. |
| `registryDoc` | no | The repo's name registry (R4). The `term` lookup answers names from this document. |
| `scan.markdown` | no, default `true` | Look for citations in markdown prose and tables. Fenced code blocks are skipped. |
| `scan.codeComments` | no, default `true` | Look for citations in comments of indexed code (TS/JS, C#, and Vue `<script>` once Vue lands). |
| `citations[].id` | yes | A stable name for the pattern. It is echoed on every edge it produces, so results can be filtered by kind. |
| `citations[].pattern` | yes | A JavaScript regular expression, applied to one line at a time, with no flags. Capture groups feed `{n}` below. |
| `citations[].target` | yes | Repo-relative path or glob of the cited document, with `{n}` replaced by capture group n. It must match exactly one file. Zero or several matches keep the citation as an unresolved edge with the reason; it is never dropped. |
| `citations[].anchor.kind` | yes | `file`, `heading`, `tableRow` or `testName`. |
| `citations[].anchor.value` | for `heading` / `tableRow` / `testName` | The text to find, with `{n}` substitution. `heading` matches like `query_docs` section mode (a case-insensitive prefix, markup ignored). `tableRow` matches a markdown table row whose cell `column` (1-based) equals the value after trimming and an optional leading `#`. `testName` matches an `it(` / `test(` / `describe(` title literal in the target file. |
| `citations[].anchor.column` | for `tableRow` | Which cell holds the row key. Default `1`. |

### Rules

- One line can carry several citations, and each produces its own edge.
- An invalid regex, or a missing `target` / `anchor.kind`, rejects that one entry. The rest of the file
  still applies, and the rejected entry is named in `health_check`.
- An anchor that cannot be found keeps the edge at file level, with reason `anchor_not_found`. The
  citation is still counted.
- Changing this file changes extraction output. The next index run re-reads it, and an incremental
  run re-scans every file when its hash changes.
