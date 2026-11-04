## MCP-ISSUE-116 — `query_docs` mode `section` could only be addressed by heading prefix

- **Status:** ✅ FIXED 2026-11-04 (IX-6, wec.aria request D5).
- **Scenario:** wec.aria agents holding a line from a grep hit, or only a word of a heading ("discover" for
  "## Discoveries"), had no way to ask for the section; `headingPrefix` needs the heading's start. They fell back to
  `sed -n` line ranges.
- **Tool/query:** `query_docs{ mode:"section", filePath:"checks/board/README.md", headingPrefix:"discover" }` — no heading
  *starts* with it, so not_found.
- **Expected vs actual:** a section is reachable from a line number or from a fragment of its title.
- **Fix:** two optional args, exactly one of `headingPrefix` | `headingContains` | `line` required (schema refine):
  `headingContains` is a case-insensitive, markup-blind substring (exact heading first, then document order; further
  matches in `otherMatches`; a miss names the nearest headings). `line` returns the innermost section containing line N
  (`headingAtLine`); a line before the first heading or past the end is a not_found naming why. Substring only — no fuzzy
  or semantic match (no-LLM policy). Code: `docSection.ts` (`matchHeadingsContaining`, `headingAtLine`), `readDocSection`
  in `impactHandler.ts`, `readMetadata.ts` schema + tool description (says when to use each).
- **Guarded:** `docSection.test.ts` — "headingContains finds 'Discoveries' from 'discover' (wec.aria's case)", the
  innermost-section and edge-line tests (first line, heading line, last line, preamble), and the exactly-one schema test.
- **Impact:** none for existing callers; `headingPrefix` behaves as before.
